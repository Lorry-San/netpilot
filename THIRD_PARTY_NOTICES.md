# Third-Party Notices

## NextTrace

NetPilot Agent installations and the Alpine Agent image include NextTrace v1.7.1 from the NTrace-core project:

- Project: https://github.com/nxtrace/NTrace-core
- Exact source: https://github.com/nxtrace/NTrace-core/tree/v1.7.1
- License: GNU General Public License, version 3.0
- Copyright: the NextTrace contributors

The installer places the corresponding GPL-3.0 license text at `/usr/share/licenses/nexttrace/LICENSE`. NetPilot invokes NextTrace as a separate executable and does not modify its binary.

NextTrace GeoIP providers and MapTrace are external services with their own terms. NetPilot disables GeoIP and external map generation by default. The `uid=1` administrator must explicitly configure a provider and is responsible for obtaining any required permission.
