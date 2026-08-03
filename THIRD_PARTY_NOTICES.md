# Third-Party Notices

## NextTrace

NetPilot Agent installations and the Alpine Agent image include NextTrace v1.7.1 from the NTrace-core project:

- Project: https://github.com/nxtrace/NTrace-core
- Exact source: https://github.com/nxtrace/NTrace-core/tree/v1.7.1
- License: GNU General Public License, version 3.0
- Copyright: the NextTrace contributors

The installer places the corresponding GPL-3.0 license text at `/usr/share/licenses/nexttrace/LICENSE`. NetPilot invokes NextTrace as a separate executable and does not modify its binary.

NextTrace GeoIP providers and MapTrace are external services with their own terms. NetPilot disables GeoIP and external map generation by default. The `uid=1` administrator must explicitly configure a provider and is responsible for obtaining any required permission.

## WenQuanYi Micro Hei

The NetPilot server bundles the WenQuanYi Micro Hei font at `assets/fonts/WenQuanYiMicroHei.ttc` so Telegram speed charts can rasterize axis numbers, data point values, legends and CJK titles on hosts without system fonts:

- Project: https://wenq.org/ (mirror: https://github.com/anthonyfok/fonts-wqy-microhei)
- Copyright: digitized data copyright 2007 Google Corporation; 2008-2009 WenQuanYi Project Board of Trustees
- License: dual-licensed under Apache License 2.0 or GPL-3.0 with font embedding exceptions; NetPilot redistributes it under Apache License 2.0

Both license texts are kept alongside the font in `assets/fonts/`. NetPilot uses the font as-is for chart rasterization and does not modify it.
