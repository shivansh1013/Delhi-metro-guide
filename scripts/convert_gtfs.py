"""Convert the supplied Delhi-NCR GTFS files into small JSON data files."""

import csv
import json
from collections import Counter, defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
GTFS_ROOT = ROOT / "data" / "gtfs"
WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday")
OUTPUT_DIR = ROOT / "data"


def find_gtfs_dir():
    """Find the folder containing the four GTFS tables."""
    required = ("stops.txt", "routes.txt", "trips.txt", "stop_times.txt")
    candidates = [GTFS_ROOT]
    candidates.extend(path.parent for path in GTFS_ROOT.rglob("stops.txt"))
    for folder in candidates:
        if all((folder / name).is_file() for name in required):
            return folder
    expected = ", ".join(required)
    raise FileNotFoundError(f"Could not find {expected} under {GTFS_ROOT}")


def read_table(folder, filename):
    with (folder / filename).open(encoding="utf-8-sig", newline="") as source:
        return list(csv.DictReader(source))


def choose_weekday_service(folder, trips):
    """Choose one weekday service listed in calendar.txt, when available."""
    trip_services = {trip["service_id"] for trip in trips}
    calendar_path = folder / "calendar.txt"
    if calendar_path.is_file():
        calendar = read_table(folder, "calendar.txt")
        candidates = [
            row for row in calendar
            if any(row.get(day) == "1" for day in WEEKDAYS)
            and row.get("service_id") in trip_services
        ]
        if candidates:
            candidates.sort(
                key=lambda row: (
                    not all(row.get(day) == "1" for day in WEEKDAYS),
                    any(row.get(day) == "1" for day in ("saturday", "sunday")),
                )
            )
            return candidates[0]["service_id"], candidates[0]
        raise ValueError("calendar.txt has no weekday service used by trips.txt")

    preferred = [service for service in trip_services if service.lower() == "weekday"]
    if not preferred:
        preferred = sorted(
            service for service in trip_services if "weekday" in service.lower()
        )
    if not preferred:
        raise ValueError("No weekday service found in trips.txt or calendar.txt")
    return preferred[0], None


def parse_time(value):
    """Convert GTFS HH:MM:SS times, including times after midnight, to seconds."""
    hours, minutes, seconds = (int(part) for part in value.split(":"))
    return hours * 3600 + minutes * 60 + seconds


def format_time(seconds):
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02}:{minutes:02}:{seconds:02}"


def display_name(station_id, stations):
    station = stations.get(station_id)
    return station["name"] if station else station_id


def main():
    gtfs_dir = find_gtfs_dir()
    stops = read_table(gtfs_dir, "stops.txt")
    routes = read_table(gtfs_dir, "routes.txt")
    trips = read_table(gtfs_dir, "trips.txt")
    stop_times = read_table(gtfs_dir, "stop_times.txt")
    service_id, calendar_row = choose_weekday_service(gtfs_dir, trips)

    stations = {}
    missing_coordinates = []
    duplicate_names = defaultdict(list)
    for stop in stops:
        station_id = stop["stop_id"]
        try:
            lat = float(stop["stop_lat"])
            lng = float(stop["stop_lon"])
        except (TypeError, ValueError):
            lat = None
            lng = None
            missing_coordinates.append(station_id)

        name = stop["stop_name"].strip()
        stations[station_id] = {
            "id": station_id,
            "name": name,
            "lat": lat,
            "lng": lng,
            "lines": [],
        }
        duplicate_names[" ".join(name.casefold().split())].append(station_id)

    route_by_id = {route["route_id"]: route for route in routes}
    route_names = {}
    used_names = set()
    for route in routes:
        name = route["route_long_name"].strip() or route["route_short_name"].strip()
        name = name or route["route_id"]
        if name in used_names:
            name = f"{name} [{route['route_id']}]"
        used_names.add(name)
        route_names[route["route_id"]] = name

    stops_by_trip = defaultdict(list)
    for row in stop_times:
        stops_by_trip[row["trip_id"]].append(row)
    for rows in stops_by_trip.values():
        rows.sort(key=lambda row: int(row["stop_sequence"]))

    segment_durations = defaultdict(list)
    for trip in trips:
        if trip["service_id"] != service_id:
            continue
        rows = stops_by_trip.get(trip["trip_id"], [])
        for current, following in zip(rows, rows[1:]):
            departure = current["departure_time"] or current["arrival_time"]
            arrival = following["arrival_time"] or following["departure_time"]
            if not departure or not arrival:
                continue
            duration = (parse_time(arrival) - parse_time(departure)) / 60
            if duration >= 0:
                segment_durations[(current["stop_id"], following["stop_id"])].append(
                    duration
                )

    segments = defaultdict(dict)
    for (from_id, to_id), durations in segment_durations.items():
        segments[from_id][to_id] = round(sum(durations) / len(durations), 1)

    route_trip_sequences = defaultdict(list)
    direction_groups = defaultdict(list)
    for trip in trips:
        ordered_rows = stops_by_trip.get(trip["trip_id"], [])
        if not ordered_rows:
            continue
        route_id = trip["route_id"]
        sequence = tuple(row["stop_id"] for row in ordered_rows)
        terminal_id = sequence[-1]
        route_trip_sequences[route_id].append((trip, sequence))
        direction_groups[(route_id, terminal_id)].append((trip, ordered_rows))

    lines = {}
    for route_id, candidates in route_trip_sequences.items():
        route_name = route_names.get(route_id, route_id)
        _, longest_sequence = max(
            candidates, key=lambda candidate: len(candidate[1])
        )
        lines[route_name] = list(longest_sequence)
        for station_id in longest_sequence:
            if station_id in stations and route_name not in stations[station_id]["lines"]:
                stations[station_id]["lines"].append(route_name)

    timings = {}
    branch_warnings = []
    for (route_id, terminal_id), group in direction_groups.items():
        sequences = defaultdict(list)
        for trip, ordered_rows in group:
            sequence = tuple(row["stop_id"] for row in ordered_rows)
            sequences[sequence].append(trip["trip_id"])
        if len(sequences) > 1:
            branch_warnings.append((route_id, terminal_id, sequences))

        headsigns = Counter(
            trip["trip_headsign"].strip()
            for trip, _ in group
            if trip["trip_headsign"].strip()
        )
        direction_name = (
            headsigns.most_common(1)[0][0]
            if headsigns
            else display_name(terminal_id, stations)
        )
        departures = []
        for trip, ordered_rows in group:
            if trip["service_id"] != service_id:
                continue
            first_stop = ordered_rows[0]
            departure = first_stop["departure_time"] or first_stop["arrival_time"]
            if departure:
                departures.append(parse_time(departure))

        if not departures:
            continue
        departures.sort()
        gaps = [
            (later - earlier) / 60
            for earlier, later in zip(departures, departures[1:])
        ]
        average_gap = round(sum(gaps) / len(gaps), 1) if gaps else None
        route_name = route_names.get(route_id, route_id)
        timings.setdefault(route_name, {})[direction_name] = {
            "terminalStationId": terminal_id,
            "serviceId": service_id,
            "firstTrain": format_time(departures[0]),
            "lastTrain": format_time(departures[-1]),
            "averageGapMinutes": average_gap,
        }

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    outputs = {
        "stations.json": list(stations.values()),
        "lines.json": lines,
        "timings.json": timings,
        "segments.json": dict(segments),
    }
    for filename, data in outputs.items():
        with (OUTPUT_DIR / filename).open("w", encoding="utf-8") as target:
            json.dump(data, target, ensure_ascii=False, indent=2)
            target.write("\n")

    print(f"GTFS source: {gtfs_dir.relative_to(ROOT)}")
    print(f"Weekday service selected: {service_id}")
    if calendar_row and calendar_row.get("end_date"):
        print(f"Calendar service end date: {calendar_row['end_date']}")
    print(f"Stations: {len(stations)}")
    print(f"Lines: {len(lines)}")
    print(f"Weekday segment directions with average times: {sum(len(edges) for edges in segments.values())}")
    duplicates = [
        (name, ids) for name, ids in duplicate_names.items()
        if name and len(ids) > 1
    ]
    print("Duplicate station names:")
    if duplicates:
        for name, ids in duplicates:
            print(f"  {name}: {', '.join(ids)}")
    else:
        print("  none")
    print("Stations with missing coordinates:")
    if missing_coordinates:
        for station_id in missing_coordinates:
            print(f"  {station_id}: {display_name(station_id, stations)}")
    else:
        print("  none")
    print("Branch warnings (different stop orders for the same route and terminal):")
    if branch_warnings:
        for route_id, terminal_id, sequences in branch_warnings:
            print(
                f"  {route_names.get(route_id, route_id)} -> "
                f"{display_name(terminal_id, stations)}"
            )
            for sequence, trip_ids in sequences.items():
                names = " -> ".join(display_name(stop_id, stations) for stop_id in sequence)
                print(f"    {names} (trips: {', '.join(trip_ids)})")
    else:
        print("  none")


if __name__ == "__main__":
    main()