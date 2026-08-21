package main

import "testing"

func TestParseMetricIgnoresIperfSummaryRows(t *testing.T) {
	interval := "[  5]   9.00-10.00  sec  83.4 MBytes   699 Mbits/sec"
	metric, ok := parseMetric(interval)
	if !ok || metric["second"] != float64(10) || metric["sendMbps"] != float64(699) {
		t.Fatalf("expected interval metric, got %#v, %v", metric, ok)
	}

	for _, line := range []string{
		"[  5]   0.00-10.20  sec   701 MBytes   577 Mbits/sec    0 sender",
		"[  5]   0.00-10.00  sec   679 MBytes   570 Mbits/sec receiver",
	} {
		if metric, ok := parseMetric(line); ok || metric != nil {
			t.Fatalf("expected summary row to be ignored: %q", line)
		}
	}
}

func TestParseMetricUsesSumRowsForParallelTests(t *testing.T) {
	stream := "[  5]   1.00-2.00 sec  20.0 MBytes  168 Mbits/sec"
	if metric, ok := parseMetric(stream, 2); ok || metric != nil {
		t.Fatalf("expected individual stream row to be ignored: %#v", metric)
	}

	sum := "[SUM]   1.00-2.00 sec  40.0 MBytes  336 Mbits/sec"
	metric, ok := parseMetric(sum, 2)
	if !ok || metric["sendMbps"] != float64(336) {
		t.Fatalf("expected SUM metric, got %#v, %v", metric, ok)
	}
}
