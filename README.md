# Awesome Pimoroni Presto  [![Awesome](https://awesome.re/badge.svg)](https://awesome.re)
# A curated list of awesome Pimoroni Presto resources.

<p float="left">
<img src="https://shop.pimoroni.com/cdn/shop/files/presto-6_1500x1500_crop_center.jpg" alt="Pimoroni Presto Side" width="250" height="250">
<img src="https://shop.pimoroni.com/cdn/shop/files/presto-4_1500x1500_crop_center.jpg" alt="Pimoroni Presto Front" width="250" height="250">
<img src="https://shop.pimoroni.com/cdn/shop/files/presto-9_1500x1500_crop_center.jpg" alt="Pimoroni Presto Back" width="250" height="250">
</p>

Presto is your new RP2350-powered, connected desktop companion! It features a 4" square touchscreen, elegant black aluminium stand and RGB backlighting.

## Contents

- [Official Resources](#official-resources)
- [Code Examples](#code-examples)
- [Development Tools](#development-tools)
- [Tutorials](#tutorials)
- [Games](#games)
- [Clocks](#clocks)
- [Weather Stations](#weather-stations)
- [Operating Systems](#operating-systems)
- [Other Projects](#other)
- [Community & Media](#community--media)
- [Contributing](#i-want-to-contribute)
- [License](#license)

### Official Resources

- [Product Page](https://shop.pimoroni.com/products/presto) – specifications, purchasing information and accessory recommendations direct from Pimoroni.
- [Getting Started Guide](https://learn.pimoroni.com/article/getting-started-with-presto) – official walk-through covering setup, firmware flashing and the basics of the Presto interface; see the Touch & Vector Fonts section for button-handling and vector-font snippets.
- [GitHub Releases & Firmware](https://github.com/pimoroni/presto/releases) – latest MicroPython builds (incl. "with-filesystem") and example updates.

### Code Examples

- [Official Presto Repo](https://github.com/pimoroni/presto)
- [Cached Examples](https://github.com/AndrewCapon/presto-cached-examples)
- [Home Assistant WebSocket Light Control](https://github.com/pimoroni/presto/tree/main/examples/home_assistant) — official example that syncs a light's state with Home Assistant over WebSocket and toggles it from the touchscreen. ![NEW](badges/new.svg)
- [SCD41 CO₂ Monitor](https://github.com/pimoroni/presto/blob/main/examples/co2.py) — official example plotting CO₂, temperature and humidity history with min/max readings and rear LEDs coloured by CO₂ level; requires an SCD41 breakout. ![NEW](badges/new.svg)

### Development Tools

- [Pimoroni Emulator](https://github.com/iksaif/pimoroni-emu) — unofficial desktop emulator with simulated Presto graphics and mouse-as-touch, plus headless testing and screenshot capture. ![NEW](badges/new.svg)
- [Embedded Swift Presto Firmware](https://github.com/velocityzen/Presto) — Swift firmware/BSP with SwiftUI-inspired views, Pico SDK UF2 build and host-side UI tests. ![NEW](badges/new.svg)

### Tutorials

- [Get the Latest News with Presto](https://learn.pimoroni.com/article/build-a-presto-newsfeed-app) — official Pimoroni Learn tutorial (29 May 2026) for a Wi-Fi RSS news reader with MicroPython, PicoVector and QR codes. ![NEW](badges/new.svg)
- [Presto Development Workflow (VS Code + mpremote/MicroPico)](https://forums.pimoroni.com/t/presto-development-workflow/28105) — tips for a faster edit–run loop and deploying from VS Code instead of Thonny.
- [Wi-Fi API Demo](https://forums.pimoroni.com/t/presto-wifi-demo/26947)
- [Touchscreen Demo](https://forums.pimoroni.com/t/presto-touch-screen-demo/26915)
- [Explorer Demo](https://forums.pimoroni.com/t/pimoroni-explorer-kit-tutorial/26501/4)

### Games

- [Presto Snake](https://github.com/jake1164/presto-snake)

### Clocks

- [Fish Tank Clock](https://github.com/arturo182/presto-examples/tree/main/fish_tank)
- [Word Clock Extra](https://github.com/arturo182/presto-examples/tree/main/word_clock_extra)
- [Presto Flip Clock](https://gist.github.com/cvuorinen/96e4934e1d681a5cfd7333c49fcd0f90) — clean split‑flap style clock; good reference for vector text + animation pacing.
- [Masterclock lookalike](https://github.com/burne-code/presto-ledclock)
  
### Weather Stations

- [Weather Station](https://www.kevsrobots.com/blog/weather-station-display.html)

### Operating Systems

- [TmOS](https://github.com/themissingcow/pimoroni-presto-tmos)

### Other Projects

- [Desktop Companion](https://git.hack-hro.de/kmohrf/compresto)
- [last.fm playing](https://github.com/andypiper/presto-lastfm)
- [PrestoDeck - Spotify music controller](https://github.com/fatihak/PrestoDeck)
- [prestohoho - Joke display](https://github.com/mrglennjones/prestohoho)
- [MQTT display](https://github.com/digitalurban/Presto_MQTT_Display)
- [AI Image Gallery](https://github.com/mrglennjones/pimoroni-presto-AI-image-gallery)
- [WiiM "What's Playing" display](https://github.com/retired-guy/WiiM-Presto) – album art & metadata from WiiM streamers.
- [Presto Stream Deck Controller](https://github.com/goodeb/Presto-Stream-Deck) – touch button deck; maps presses to actions.
- [Presto Maze](https://github.com/kurosuke/PrestoMaze) – interactive maze/pathfinding demo with touch input.
- [X‑Plane 12 Attitude Indicator](https://github.com/PaulskPt/Presto_attitude_indicator_for_X-Plane12) – horizon instrument fed from a flight sim.
- [Solar System demo](https://github.com/mrglennjones/presto-solar-system) – animated planets and orbits.
- [Presto MQTT Multi-Topic Subscriber](https://github.com/PaulskPt/Presto_MQTT_multi_topic_subscriber) — MicroPython app subscribing to multiple MQTT topics for sensor telemetry and remote LED/colour commands, with publisher examples. ![RECENT](badges/recent.svg)
- [LMS Controller (Logitech Media Server)](https://github.com/goodeb/LMS_controller) — now-playing display and touchscreen transport controller for a Lyrion/Logitech Media Server ([forum overview](https://forums.pimoroni.com/t/presto-music-system-display-controller/28312)). ![RECENT](badges/recent.svg)
- [Presto-Cal (iCalendar + Timezone/DST)](https://github.com/dan-parker/Presto-Cal) — iCalendar viewer with MicroPython timezone and daylight-saving-time handling ([forum post](https://forums.pimoroni.com/t/micropython-timezone-and-dst-library/28318)). ![RECENT](badges/recent.svg)
- [MacStatP — macOS System Monitor](https://github.com/vwillcox/MacStatP) — macOS CPU/GPU, memory, disk, network and process telemetry sent over USB serial to a tappable Presto dashboard. ![NEW](badges/new.svg)
- [BuddyPresto — Claude Desk Pet](https://github.com/vwillcox/BuddyPresto) — Bluetooth-connected Claude session companion with permission approval/denial, session summaries and LED/buzzer alerts. ![NEW](badges/new.svg)
- [Presto Immich Slideshow](https://github.com/vwillcox/presto-immich) — displays albums from a self-hosted Immich server as a touchscreen photo frame with web-based configuration. ![NEW](badges/new.svg)
- [PrestoDeck for Music Assistant](https://github.com/jbslabs/PrestoDeckforMA) — Music Assistant/Home Assistant/MQTT fork of PrestoDeck with multi-provider playback, MQTT discovery and display/LED automation. ![NEW](badges/new.svg)
- [Presto Cockpit](https://github.com/AEON-7/presto-cockpit) — multi-screen AI/GPU home-lab dashboard for agent activity, GPU/host metrics, uptime, sensors, crypto, news and clocks; optional backend services. ![NEW](badges/new.svg)
- [Presto Poetry Kiosk](https://github.com/svandragt/presto-poetrykiosk) — MicroPython kiosk shuffling photo-and-poem slides with overlaid text and fade transitions. ![NEW](badges/new.svg)

### Community & Media

- [Pimoroni Community Forum](https://forums.pimoroni.com) – latest Presto builds, troubleshooting threads and announcements direct from Pimoroni staff.
- [Pimoroni Discord](https://discord.gg/pimoroni) – active chat with Pimoroni engineers and fellow makers.
- [PrestoDeck on Hackster](https://www.hackster.io/news/fatih-ak-turns-pimoroni-s-presto-into-a-slick-spotify-media-controller-the-prestodeck-687119f2c456) – write-up with build details and video.
- [Building a MicroPython Weather Station on Presto — Kevin McAleer (YouTube)](https://www.classcentral.com/course/youtube-is-pimoroni-presto-the-best-micropython-touchscreen-432181) — hands-on tutorial covering touch UI, charts, and live data.

### I want to contribute!

Great! :smiley:

Please, read the [contribution guidelines](CONTRIBUTING.md) first.

### License

[![CC0](https://i.creativecommons.org/p/zero/1.0/88x31.png)](https://creativecommons.org/publicdomain/zero/1.0/)

To the extent possible under law I have waived all copyright and related or neighboring rights to this work.

See [LICENSE](LICENSE) for more information.
