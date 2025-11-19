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
- [Tutorials](#tutorials)
- [Games](#games)
- [Clocks](#clocks)
- [Weather Stations](#weather-stations)
- [Operating Systems (OS)](#operating-systems)
- [Other Projects](#other)
- [Community & Media](#community--media)
- [Contributing](#i-want-to-contribute)
- [License](#license)
  

### Official Resources
- [Product Page](https://shop.pimoroni.com/products/presto) – specifications, purchasing information and accessory recommendations direct from Pimoroni.
- [Getting Started Guide](https://learn.pimoroni.com/article/getting-started-with-presto) – official walk-through covering setup, firmware flashing and the basics of the Presto interface; see the Touch & Vector Fonts section for button-handling and vector-font snippets. ![NEW](badges/new.svg)
- [Launch Blog Post](https://www.pimoroni.com/blog/presenting-presto) – background on the design goals, hardware overview and inspiration for the device.
- [GitHub Releases & Firmware](https://github.com/pimoroni/presto/releases) ![RECENT](badges/recent.svg) – latest MicroPython builds (incl. "with-filesystem") and example updates.

### Code Examples
- [Official Presto Repo](https://github.com/pimoroni/presto)
- [Cached Examples](https://github.com/AndrewCapon/presto-cached-examples)
- [Presto C++ Boilerplate](https://github.com/pimoroni/pimoroni-pico/tree/main/examples/presto) ![RECENT](badges/recent.svg) – minimal C++ starter for RP2350/Presto apps.
- [Presto MQTT Multi-Topic Subscriber (MicroPython)](https://github.com/PaulskPt/Presto_MQTT_multi_topic_subscriber) — subscribes to multiple MQTT topics to drive backlight LEDs, colors, and on-screen data; includes setup notes and secrets template. ![NEW](badges/new.svg) 
- [LMS Controller (Logitech Media Server) for Presto](https://github.com/goodeb/LMS_controller) — browse/play/pause/skip for LMS right from the Presto touch UI. ![NEW](badges/new.svg)  
  
### Tutorials
- [Presto Development Workflow (VS Code + mpremote/MicroPico)](https://forums.pimoroni.com/t/presto-development-workflow/28105) — tips for a faster edit–run loop and deploying from VS Code instead of Thonny. ![NEW](badges/new.svg)
- [Wi-Fi API Demo](https://forums.pimoroni.com/t/presto-wifi-demo/26947)
- [Touchscreen Demo](https://forums.pimoroni.com/t/presto-touch-screen-demo/26915)
- [Explorer Demo](https://forums.pimoroni.com/t/pimoroni-explorer-kit-tutorial/26501/4)
- [HackSpace Magazine Quickstart](https://hackspace.raspberrypi.com/articles/pimoroni-presto) – magazine feature that walks through the hardware and first projects.
- [Tom's Hardware Hands-on](https://www.tomshardware.com/raspberry-pi/pimoroni-presto-hands-on) – overview of the experience, including setup tips and impressions.


### Games
- [Presto Snake](https://github.com/jake1164/presto-snake)
- [Presto Pianocade](https://github.com/simongs/presto-pianocade) – turns the display into a colourful musical pad using the onboard speaker.


### Clocks
- [Fish Tank Clock](https://github.com/arturo182/presto-examples/tree/main/fish_tank)
- [Word Clock Extra](https://github.com/arturo182/presto-examples/tree/main/word_clock_extra)
- [Retro Flip Clock + 3D-printed frame](https://forums.pimoroni.com/t/retro-style-flip-clock-for-presto-with-3d-printed-frame/26791) ![RECENT](badges/recent.svg)


### Weather Stations
- [Weather Station](https://www.kevsrobots.com/blog/weather-station-display.html)
- [Home Assistant Weather Dashboard](https://github.com/glowfishtech/presto-home-assistant-weather) – live sensor readings and forecasts pulled from Home Assistant via MQTT.


### Operating Systems
- [TmOS](https://github.com/themissingcow/pimoroni-presto-tmos)


### Other
- [Desktop Companion](https://git.hack-hro.de/kmohrf/compresto)
- [last.fm playing](https://github.com/andypiper/presto-lastfm)
- [PrestoDock - Spotify music controller](https://github.com/fatihak/PrestoDeck)
- [prestohoho - Joke display](https://github.com/mrglennjones/prestohoho)
- [MQTT display](https://github.com/digitalurban/Presto_MQTT_Display)
- [AI Image Gallery](https://github.com/mrglennjones/pimoroni-presto-AI-image-gallery)
- [Presto Smart Calendar](https://github.com/itsaknife/presto-smart-calendar) – integrates Google Calendar and task reminders with animated backgrounds.
- [Presto Ambient Light Controller](https://github.com/matthewgough/presto-ambient-light) – drive Philips Hue and WLED scenes from the Presto touchscreen.
- [Presto RSS Headlines](https://github.com/lucypw/presto-rss-headlines) – fetches favourite news feeds and displays rotating summaries.
- [WiiM "What’s Playing" display](https://forums.pimoroni.com/t/wiim-now-playing-on-presto/26123) ![RECENT](badges/recent.svg) – album art & metadata from WiiM streamers.
- [Presto Stream Deck Controller](https://forums.pimoroni.com/t/stream-deck-style-controller-for-presto/26380) ![RECENT](badges/recent.svg) – touch button deck; maps presses to actions.
- [Presto Maze](https://github.com/kurosuke/PrestoMaze) ![RECENT](badges/recent.svg) – interactive maze/pathfinding demo with touch input.
- [X‑Plane 12 Attitude Indicator](https://github.com/PaulskPt/Presto_attitude_indicator_for_X-Plane12) ![RECENT](badges/recent.svg) – horizon instrument fed from a flight sim.
- [Solar System demo](https://github.com/mrglennjones/presto-solar-system) ![RECENT](badges/recent.svg) – animated planets and orbits.
- [Presto‑Cal (TZ/DST + iCal agenda)](https://github.com/dan-parker/Presto-Cal) ![RECENT](badges/recent.svg) – timezone helpers and iCal agenda app for Presto.


### Community & Media
- [Pimoroni Community Forum](https://forums.pimoroni.com/tag/presto) – latest Presto builds, troubleshooting threads and announcements direct from Pimoroni staff.
- [Pimoroni Discord](https://discord.gg/pimoroni) – active chat with Pimoroni engineers and fellow makers.
- [YouTube Launch Stream](https://www.youtube.com/watch?v=LXnX1gOQtN0) – hour-long deep dive with hardware demos and Q&A from the Pimoroni crew.
- [Hackaday Coverage](https://hackaday.com/2024/06/14/pimoroni-presto-the-touchscreen-desktop-companion) – highlights notable community projects and reactions.
- [PrestoDeck on Hackster](https://www.hackster.io/fatih_ak/presto-deck-turn-your-presto-into-a-spotify-music-player-40a1b0) ![RECENT](badges/recent.svg) – write-up with build details and video.
- [Building a MicroPython Weather Station on Presto — Kevin McAleer (YouTube)](https://www.classcentral.com/course/youtube-is-pimoroni-presto-the-best-micropython-touchscreen-432181) — hands-on tutorial covering touch UI, charts, and live data. ![NEW](badges/new.svg)

### I want to contribute!

Great! :smiley:

Please, read the [contribution guidelines](CONTRIBUTING.md) first.

### License

[![CC0](https://i.creativecommons.org/p/zero/1.0/88x31.png)](https://creativecommons.org/publicdomain/zero/1.0/)

To the extent possible under law I have waived all copyright and related or neighboring rights to this work.

See [LICENSE](LICENSE) for more information.