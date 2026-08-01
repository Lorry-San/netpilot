package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

var version = "dev"

type config struct {
	Server  string
	Token   string
	AgentID string
	Name    string
}

type message struct {
	Type    string         `json:"type"`
	TaskID  string         `json:"taskId,omitempty"`
	Token   string         `json:"token,omitempty"`
	Payload map[string]any `json:"payload,omitempty"`
}

type taskParams struct {
	Target    string `json:"target"`
	Port      int    `json:"port"`
	Protocol  string `json:"protocol"`
	Reverse   bool   `json:"reverse"`
	Duration  int    `json:"duration"`
	Parallel  int    `json:"parallel"`
	Bandwidth string `json:"bandwidth"`
}

type client struct {
	conn       *websocket.Conn
	writeMu    sync.Mutex
	tasksMu    sync.Mutex
	activeTask string
	cancelTask context.CancelFunc
}

type cpuSample struct {
	total uint64
	idle  uint64
}

type netSample struct {
	received uint64
	sent     uint64
	at       time.Time
}

var bitratePattern = regexp.MustCompile(`([0-9]+(?:\.[0-9]+)?)\s+([KMG])bits/sec`)
var intervalPattern = regexp.MustCompile(`([0-9]+(?:\.[0-9]+)?)-([0-9]+(?:\.[0-9]+)?)\s+sec`)

func getenv(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func parseConfig() config {
	server := flag.String("server", getenv("NETPILOT_SERVER", ""), "NetPilot WebSocket URL")
	token := flag.String("token", getenv("NETPILOT_TOKEN", ""), "Agent registration token")
	agentID := flag.String("agent-id", getenv("NETPILOT_AGENT_ID", ""), "Agent ID")
	name := flag.String("name", getenv("NETPILOT_AGENT_NAME", ""), "Agent display name")
	showVersion := flag.Bool("version", false, "Print version")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		os.Exit(0)
	}
	if *server == "" || *token == "" || *agentID == "" {
		log.Fatal("--server, --token and --agent-id are required")
	}
	parsed, err := url.Parse(*server)
	if err != nil || (parsed.Scheme != "ws" && parsed.Scheme != "wss") {
		log.Fatal("server must be a valid ws:// or wss:// URL")
	}
	return config{Server: *server, Token: *token, AgentID: *agentID, Name: *name}
}

func (c *client) send(value any) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.conn.WriteJSON(value)
}

func (c *client) setTask(taskID string, cancel context.CancelFunc) bool {
	c.tasksMu.Lock()
	defer c.tasksMu.Unlock()
	if c.activeTask != "" {
		return false
	}
	c.activeTask = taskID
	c.cancelTask = cancel
	return true
}

func (c *client) finishTask(taskID string) {
	c.tasksMu.Lock()
	defer c.tasksMu.Unlock()
	if c.activeTask == taskID {
		c.activeTask = ""
		c.cancelTask = nil
	}
}

func (c *client) cancel(taskID string) {
	c.tasksMu.Lock()
	defer c.tasksMu.Unlock()
	if c.activeTask == taskID && c.cancelTask != nil {
		c.cancelTask()
	}
}

func normalizeTask(raw map[string]any) (taskParams, error) {
	data, err := json.Marshal(raw)
	if err != nil {
		return taskParams{}, err
	}
	var task taskParams
	if err := json.Unmarshal(data, &task); err != nil {
		return task, err
	}
	if strings.TrimSpace(task.Target) == "" || task.Port < 1 || task.Port > 65535 {
		return task, errors.New("invalid target or port")
	}
	if task.Protocol != "tcp" && task.Protocol != "udp" {
		return task, errors.New("protocol must be tcp or udp")
	}
	if task.Duration < 1 || task.Duration > 3600 || task.Parallel < 1 || task.Parallel > 32 {
		return task, errors.New("duration or parallel count is outside allowed range")
	}
	if task.Protocol == "udp" && task.Bandwidth != "" {
		if !regexp.MustCompile(`^[0-9]+(?:\.[0-9]+)?[KMG]?$`).MatchString(task.Bandwidth) {
			return task, errors.New("invalid UDP bandwidth")
		}
	}
	return task, nil
}

func iperfArgs(task taskParams) []string {
	args := []string{"-c", task.Target, "-p", strconv.Itoa(task.Port), "-t", strconv.Itoa(task.Duration), "-P", strconv.Itoa(task.Parallel), "-i", "1"}
	if task.Protocol == "udp" {
		args = append(args, "-u")
		if task.Bandwidth != "" {
			args = append(args, "-b", task.Bandwidth)
		}
	}
	if task.Reverse {
		args = append(args, "-R")
	}
	return args
}

func parseMetric(line string) (map[string]any, bool) {
	bitrate := bitratePattern.FindStringSubmatch(line)
	interval := intervalPattern.FindStringSubmatch(line)
	if len(bitrate) != 3 || len(interval) != 3 {
		return nil, false
	}
	value, err := strconv.ParseFloat(bitrate[1], 64)
	if err != nil {
		return nil, false
	}
	switch bitrate[2] {
	case "K":
		value /= 1000
	case "G":
		value *= 1000
	}
	second, _ := strconv.ParseFloat(interval[2], 64)
	return map[string]any{"second": second, "sendMbps": value, "recvMbps": value}, true
}

func streamOutput(c *client, taskID, stream string, reader io.Reader, wg *sync.WaitGroup) {
	defer wg.Done()
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		_ = c.send(message{Type: "task." + stream, TaskID: taskID, Payload: map[string]any{"line": line}})
		if stream == "stdout" {
			if metric, ok := parseMetric(line); ok {
				_ = c.send(message{Type: "task.metric", TaskID: taskID, Payload: metric})
			}
		}
	}
}

func executeTask(parent context.Context, c *client, taskID string, raw map[string]any) {
	task, err := normalizeTask(raw)
	if err != nil {
		_ = c.send(message{Type: "task.error", TaskID: taskID, Payload: map[string]any{"error": err.Error()}})
		return
	}
	ctx, cancel := context.WithTimeout(parent, time.Duration(task.Duration+30)*time.Second)
	if !c.setTask(taskID, cancel) {
		cancel()
		_ = c.send(message{Type: "task.error", TaskID: taskID, Payload: map[string]any{"error": "agent is already running a task"}})
		return
	}
	defer func() {
		cancel()
		c.finishTask(taskID)
	}()

	cmd := exec.CommandContext(ctx, "iperf3", iperfArgs(task)...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = c.send(message{Type: "task.error", TaskID: taskID, Payload: map[string]any{"error": err.Error()}})
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = c.send(message{Type: "task.error", TaskID: taskID, Payload: map[string]any{"error": err.Error()}})
		return
	}
	started := time.Now()
	if err := cmd.Start(); err != nil {
		_ = c.send(message{Type: "task.error", TaskID: taskID, Payload: map[string]any{"error": err.Error()}})
		return
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go streamOutput(c, taskID, "stdout", stdout, &wg)
	go streamOutput(c, taskID, "stderr", stderr, &wg)
	err = cmd.Wait()
	wg.Wait()
	exitCode := 0
	if err != nil {
		exitCode = -1
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			exitCode = exitError.ExitCode()
		}
	}
	_ = c.send(message{Type: "task.done", TaskID: taskID, Payload: map[string]any{"exitCode": exitCode, "durationMs": time.Since(started).Milliseconds()}})
}

func readCPU() (cpuSample, error) {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		return cpuSample{}, err
	}
	fields := strings.Fields(strings.SplitN(string(data), "\n", 2)[0])
	if len(fields) < 5 || fields[0] != "cpu" {
		return cpuSample{}, errors.New("unexpected /proc/stat format")
	}
	var values []uint64
	for _, field := range fields[1:] {
		value, parseErr := strconv.ParseUint(field, 10, 64)
		if parseErr != nil {
			return cpuSample{}, parseErr
		}
		values = append(values, value)
	}
	var total uint64
	for _, value := range values {
		total += value
	}
	idle := values[3]
	if len(values) > 4 {
		idle += values[4]
	}
	return cpuSample{total: total, idle: idle}, nil
}

func cpuPercent(previous, current cpuSample) float64 {
	totalDelta := current.total - previous.total
	if totalDelta == 0 {
		return 0
	}
	idleDelta := current.idle - previous.idle
	return float64(totalDelta-idleDelta) / float64(totalDelta) * 100
}

func memoryPercent() float64 {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	values := map[string]float64{}
	for _, line := range strings.Split(string(data), "\n") {
		parts := strings.Fields(line)
		if len(parts) >= 2 {
			value, _ := strconv.ParseFloat(parts[1], 64)
			values[strings.TrimSuffix(parts[0], ":")] = value
		}
	}
	total := values["MemTotal"]
	available := values["MemAvailable"]
	if total <= 0 {
		return 0
	}
	return (total - available) / total * 100
}

func readNetwork() netSample {
	data, err := os.ReadFile("/proc/net/dev")
	if err != nil {
		return netSample{at: time.Now()}
	}
	var received, sent uint64
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.Contains(line, ":") {
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		if strings.TrimSpace(parts[0]) == "lo" {
			continue
		}
		fields := strings.Fields(parts[1])
		if len(fields) < 9 {
			continue
		}
		rx, _ := strconv.ParseUint(fields[0], 10, 64)
		tx, _ := strconv.ParseUint(fields[8], 10, 64)
		received += rx
		sent += tx
	}
	return netSample{received: received, sent: sent, at: time.Now()}
}

func linkCapacityMbps() float64 {
	entries, err := os.ReadDir("/sys/class/net")
	if err != nil {
		return 0
	}
	var total float64
	for _, entry := range entries {
		if entry.Name() == "lo" {
			continue
		}
		data, readErr := os.ReadFile(filepath.Join("/sys/class/net", entry.Name(), "speed"))
		if readErr != nil {
			continue
		}
		value, parseErr := strconv.ParseFloat(strings.TrimSpace(string(data)), 64)
		if parseErr == nil && value > 0 {
			total += value
		}
	}
	return total
}

func networkPercent(previous, current netSample, capacityMbps float64) (float64, float64) {
	seconds := current.at.Sub(previous.at).Seconds()
	if seconds <= 0 || capacityMbps <= 0 {
		return 0, 0
	}
	up := float64(current.sent-previous.sent) * 8 / seconds / (capacityMbps * 1_000_000) * 100
	down := float64(current.received-previous.received) * 8 / seconds / (capacityMbps * 1_000_000) * 100
	return up, down
}

func heartbeatLoop(ctx context.Context, c *client) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	previousCPU, _ := readCPU()
	previousNetwork := readNetwork()
	capacity := linkCapacityMbps()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			currentCPU, _ := readCPU()
			currentNetwork := readNetwork()
			up, down := networkPercent(previousNetwork, currentNetwork, capacity)
			payload := map[string]any{"cpuPercent": cpuPercent(previousCPU, currentCPU), "memoryPercent": memoryPercent(), "uploadPercent": up, "downloadPercent": down}
			if err := c.send(message{Type: "agent.heartbeat", Payload: payload}); err != nil {
				return
			}
			previousCPU = currentCPU
			previousNetwork = currentNetwork
		}
	}
}

func connect(ctx context.Context, cfg config) error {
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, cfg.Server, nil)
	if err != nil {
		return err
	}
	defer conn.Close()
	c := &client{conn: conn}
	if err := c.send(message{Type: "agent.auth", Token: cfg.Token, Payload: map[string]any{"agentId": cfg.AgentID, "name": cfg.Name, "os": runtime.GOOS, "arch": runtime.GOARCH, "version": version}}); err != nil {
		return err
	}
	conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	var authReply message
	if err := conn.ReadJSON(&authReply); err != nil {
		return err
	}
	if authReply.Type != "agent.auth.ok" {
		return errors.New("server rejected agent authentication")
	}
	conn.SetReadDeadline(time.Time{})
	connectionCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go heartbeatLoop(connectionCtx, c)
	_ = c.send(message{Type: "agent.info", Payload: map[string]any{"os": runtime.GOOS, "arch": runtime.GOARCH, "version": version, "name": cfg.Name}})
	for {
		var incoming message
		if err := conn.ReadJSON(&incoming); err != nil {
			return err
		}
		switch incoming.Type {
		case "task.start":
			go executeTask(connectionCtx, c, incoming.TaskID, incoming.Payload)
		case "task.cancel":
			c.cancel(incoming.TaskID)
		}
	}
}

func main() {
	cfg := parseConfig()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	backoff := time.Second
	for ctx.Err() == nil {
		log.Printf("connecting to %s", cfg.Server)
		err := connect(ctx, cfg)
		if ctx.Err() != nil {
			break
		}
		log.Printf("connection closed: %v; retrying in %s", err, backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
	}
}
