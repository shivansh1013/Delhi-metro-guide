# Delhi-NCR Metro

## Stack
- Plain HTML, CSS, and JavaScript; no frameworks or backend.
- Python 3 is only for the one-time GTFS conversion script.

## Folder purpose
- `data/gtfs/`: raw GTFS `.txt` files supplied by the user.
- `data/stations.json`, `lines.json`, `timings.json`, `segments.json`: converted metro data.
- `data/fares.json`: distance-based token fares and fare effective date.
- `scripts/convert_gtfs.py`: converts GTFS data into the JSON files.
- `index.html`, `style.css`, `app.js`: website structure, styles, and behavior.
- Leaflet is loaded from its CDN for the map; map tiles are from OpenStreetMap.

## Done
- Created the project folder structure and empty starter files.
- Added this project overview and implementation rules.
- Inspected the GTFS tables and generated stations, lines, and timing JSON.
- Built a plain-text route finder using breadth-first search.
- Added estimated travel times, scheduled departure estimates, and fare estimates.
- Styled the page for mobile and desktop, including dark-mode support.
- Added an OpenStreetMap/Leaflet station map and route overlays.
- Added searchable station fields, a saved light/dark theme toggle, and a responsive two-column journey layout.

## Next
- Review distance-based fares and verify them against current DMRC guidance.
- Review the responsive route finder, map, and theme preferences.

## Rules
- Keep the code simple and commented.
- Ask before adding libraries.
- Times shown in the UI must be labeled as scheduled, not live.
- Do not build the UI or route finder before data conversion is reviewed.
- Fare slabs are effective 25 Aug 2025 and are selected using route distance.
- OpenStreetMap attribution must remain visible wherever map tiles are shown.
- The theme follows the device preference initially and remembers a user-selected theme when browser storage is available.
