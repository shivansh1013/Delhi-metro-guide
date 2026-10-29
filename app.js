const LINE_COLORS = {
  RED: { name: "Red", hex: "#d62828" },
  YELLOW: { name: "Yellow", hex: "#e5aa00" },
  BLUE: { name: "Blue", hex: "#1769aa" },
  GREEN: { name: "Green", hex: "#25864a" },
  VIOLET: { name: "Violet", hex: "#7545a5" },
  "ORANGE/AIRPORT": { name: "Orange/Airport Express", hex: "#ed7916" },
  PINK: { name: "Pink", hex: "#df5797" },
  MAGENTA: { name: "Magenta", hex: "#a6299d" },
  GREY: { name: "Grey", hex: "#68717d" },
  RAPID: { name: "Rapid", hex: "#168a83" },
  NEUTRAL: { name: "Metro", hex: "#737b86" },
};
const INTERCHANGE_ALLOWANCE_MINUTES = 5;

const sourceSelect = document.querySelector("#source");
const destinationSelect = document.querySelector("#destination");
const routeForm = document.querySelector("#route-form");
const swapButton = document.querySelector("#swap-stations");
const themeToggle = document.querySelector("#theme-toggle");
const themeIcon = document.querySelector("#theme-icon");
const themeLabel = document.querySelector("#theme-label");
const findRouteButton = document.querySelector("#find-route");
const stationOptions = document.querySelector("#station-options");
const resultMessage = document.querySelector("#result-message");
const routeDetails = document.querySelector("#route-details");
const routeList = document.querySelector("#route-list");
const totalStopsElement = document.querySelector("#total-stops");
const travelTimeElement = document.querySelector("#travel-time");
const estimatedFareElement = document.querySelector("#estimated-fare");
const fareDayLabelElement = document.querySelector("#fare-day-label");
const smartCardFareElement = document.querySelector("#smart-card-fare");
const fareDistanceElement = document.querySelector("#fare-distance");
const airportFareNote = document.querySelector("#airport-fare-note");
const nextTrainsElement = document.querySelector("#next-trains");
const mapStatus = document.querySelector("#map-status");

let stationsById = new Map();
let graph = new Map();
let routeData = {};
let timingData = {};
let segmentData = {};
let fareData = {};
let map = null;
let mapRouteLayer = null;
let nextMapSelection = "source";

function updateThemeButton() {
  const isDark = document.documentElement.dataset.theme === "dark";
  themeIcon.textContent = isDark ? "☀️" : "🌙";
  themeLabel.textContent = isDark ? "Light mode" : "Dark mode";
  themeToggle.setAttribute(
    "aria-label",
    isDark ? "Switch to light mode" : "Switch to dark mode"
  );
}

themeToggle.addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  updateThemeButton();
  try {
    localStorage.setItem("metro-guide-theme", theme);
  } catch {
    // The chosen theme still applies for this page when storage is unavailable.
  }
  if (map) {
    requestAnimationFrame(() => map.invalidateSize());
  }
});

updateThemeButton();

function getLineColor(routeName) {
  const prefix = routeName.split("_", 1)[0].toUpperCase();
  return prefix === "GRAY" ? "GREY" : prefix;
}

function getLineStyle(lineColor) {
  return LINE_COLORS[lineColor] || LINE_COLORS.NEUTRAL;
}

function addConnection(fromId, toId, lineColor) {
  if (!graph.has(fromId)) {
    graph.set(fromId, new Map());
  }
  if (!graph.has(toId)) {
    graph.set(toId, new Map());
  }
  if (!graph.get(fromId).has(toId)) {
    graph.get(fromId).set(toId, new Set());
  }
  if (!graph.get(toId).has(fromId)) {
    graph.get(toId).set(fromId, new Set());
  }
  graph.get(fromId).get(toId).add(lineColor);
  graph.get(toId).get(fromId).add(lineColor);
}

function buildGraph(lines) {
  routeData = lines;
  graph = new Map();
  for (const [routeName, stationIds] of Object.entries(lines)) {
    const lineColor = getLineColor(routeName);
    for (let index = 0; index < stationIds.length - 1; index += 1) {
      addConnection(stationIds[index], stationIds[index + 1], lineColor);
    }
  }
}

function getSegmentMinutes(fromId, toId) {
  const forward = segmentData[fromId]?.[toId];
  if (forward !== undefined) {
    return forward;
  }
  const reverse = segmentData[toId]?.[fromId];
  return reverse === undefined ? null : reverse;
}

function getTravelMinutes(path, colors) {
  let total = 0;
  for (let index = 0; index < path.length - 1; index += 1) {
    const minutes = getSegmentMinutes(path[index], path[index + 1]);
    if (minutes === null) {
      return null;
    }
    total += minutes;
    if (index > 0 && colors[index] !== colors[index - 1]) {
      total += INTERCHANGE_ALLOWANCE_MINUTES;
    }
  }
  return total;
}

function parseClockMinutes(value) {
  const [hours, minutes, seconds = "0"] = value.split(":");
  return Number(hours) * 60 + Number(minutes) + Number(seconds) / 60;
}

function formatClockMinutes(value) {
  const wholeMinutes = Math.round(value) % (24 * 60);
  const normalized = (wholeMinutes + 24 * 60) % (24 * 60);
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function findSourceSchedule(sourceId, nextId, lineColor) {
  for (const [routeName, stationIds] of Object.entries(routeData)) {
    if (getLineColor(routeName) !== lineColor) {
      continue;
    }
    const sourceIndex = stationIds.findIndex(
      (stationId, index) => stationId === sourceId && stationIds[index + 1] === nextId
    );
    if (sourceIndex === -1) {
      continue;
    }

    let offsetMinutes = 0;
    let hasCompleteOffset = true;
    for (let index = 0; index < sourceIndex; index += 1) {
      const segmentMinutes = getSegmentMinutes(stationIds[index], stationIds[index + 1]);
      if (segmentMinutes === null) {
        hasCompleteOffset = false;
        break;
      }
      offsetMinutes += segmentMinutes;
    }
    if (!hasCompleteOffset) {
      continue;
    }

    const directions = Object.values(timingData[routeName] || {});
    for (const direction of directions) {
      if (
        direction.terminalStationId === stationIds[stationIds.length - 1] &&
        direction.firstTrain &&
        direction.lastTrain &&
        direction.averageGapMinutes
      ) {
        return {
          firstTrain: parseClockMinutes(direction.firstTrain) + offsetMinutes,
          lastTrain: parseClockMinutes(direction.lastTrain) + offsetMinutes,
          averageGapMinutes: direction.averageGapMinutes,
        };
      }
    }
  }
  return null;
}

function getNextTrainMessages(sourceId, nextId, lineColor) {
  const schedule = findSourceSchedule(sourceId, nextId, lineColor);
  if (!schedule) {
    return ["Scheduled trains: Unavailable for this line and direction."];
  }

  const now = new Date();
  let currentMinutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  if (schedule.firstTrain >= 24 * 60 && currentMinutes < schedule.firstTrain % (24 * 60)) {
    currentMinutes += 24 * 60;
  }

  if (currentMinutes < schedule.firstTrain || currentMinutes > schedule.lastTrain) {
    const status = currentMinutes < schedule.firstTrain
      ? "Before today's first scheduled train."
      : "No more scheduled trains today.";
    return [
      `Scheduled trains: ${status} First train of the next service day: ${formatClockMinutes(schedule.firstTrain)} (Scheduled, approximate).`,
    ];
  }

  const gap = Number(schedule.averageGapMinutes);
  if (!Number.isFinite(gap) || gap <= 0) {
    return ["Scheduled trains: Unavailable because the average gap is missing."];
  }

  const firstIndex = Math.max(0, Math.ceil((currentMinutes - schedule.firstTrain) / gap));
  const departures = [];
  for (let index = firstIndex; index < firstIndex + 3; index += 1) {
    const departure = schedule.firstTrain + index * gap;
    if (departure <= schedule.lastTrain) {
      departures.push(formatClockMinutes(departure));
    }
  }
  if (departures.length === 0) {
    return [
      `Scheduled trains: No more scheduled trains today. First train tomorrow: ${formatClockMinutes(schedule.firstTrain)} (Scheduled, approximate).`,
    ];
  }
  return [
    `Next scheduled departures: ${departures.join(", ")} (Scheduled, approximate).`,
  ];
}

function getRouteDistanceKm(path) {
  let distance = 0;
  for (let index = 0; index < path.length - 1; index += 1) {
    const from = stationsById.get(path[index]);
    const to = stationsById.get(path[index + 1]);
    if (
      !from ||
      !to ||
      !Number.isFinite(from.lat) ||
      !Number.isFinite(from.lng) ||
      !Number.isFinite(to.lat) ||
      !Number.isFinite(to.lng)
    ) {
      return null;
    }

    const toRadians = (degrees) => degrees * Math.PI / 180;
    const latitudeDifference = toRadians(to.lat - from.lat);
    const longitudeDifference = toRadians(to.lng - from.lng);
    const fromLatitude = toRadians(from.lat);
    const toLatitude = toRadians(to.lat);
    const haversine =
      Math.sin(latitudeDifference / 2) ** 2 +
      Math.cos(fromLatitude) * Math.cos(toLatitude) *
      Math.sin(longitudeDifference / 2) ** 2;
    distance += 6371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
  }
  return distance;
}

function getFare(distanceKm, now = new Date()) {
  if (distanceKm === null) {
    return null;
  }
  const slab = fareData.slabs.find(
    (entry) => distanceKm <= entry.maxKm || entry.maxKm === null
  );
  if (!slab) {
    return null;
  }

  const isSunday = now.getDay() === 0;
  const tokenFare = isSunday ? slab.sunHoliday : slab.monSat;
  const minutesAfterMidnight = now.getHours() * 60 + now.getMinutes();
  const isOffPeak =
    minutesAfterMidnight < 8 * 60 ||
    (minutesAfterMidnight >= 12 * 60 && minutesAfterMidnight < 17 * 60) ||
    minutesAfterMidnight > 21 * 60;
  const discount = isOffPeak ? 0.2 : 0.1;
  return {
    tokenFare,
    smartCardFare: Math.round(tokenFare * (1 - discount)),
    smartCardLabel: isOffPeak ? "Smart card, off-peak" : "Smart card",
    dayLabel: isSunday ? "Sunday fare" : "Mon-Sat fare",
  };
}

function populateStationOptions(stations) {
  const sortedStations = [...stations].sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  stationsById = new Map(sortedStations.map((station) => [station.id, station]));
  for (const station of sortedStations) {
    const option = document.createElement("option");
    option.value = station.name;
    stationOptions.append(option);
  }
}

function getStationId(input) {
  const stationName = input.value.trim().toLocaleLowerCase();
  const station = [...stationsById.values()].find(
    (item) => item.name.toLocaleLowerCase() === stationName
  );
  return station ? station.id : "";
}

function initializeMap(stations) {
  if (!window.L) {
    mapStatus.textContent = "Map unavailable while offline. Route search still works.";
    return;
  }

  try {
    map = window.L.map("map").setView([28.6139, 77.209], 10);
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      maxZoom: 19,
    }).addTo(map);
    mapRouteLayer = window.L.layerGroup().addTo(map);

    for (const station of stations) {
      if (!Number.isFinite(station.lat) || !Number.isFinite(station.lng)) {
        continue;
      }
      const marker = window.L.circleMarker([station.lat, station.lng], {
        radius: 4,
        color: "#ffffff",
        weight: 1,
        fillColor: "#344054",
        fillOpacity: 0.9,
      }).addTo(map);
      const popup = document.createElement("span");
      popup.textContent = station.name;
      marker.bindPopup(popup);
      marker.on("click", () => selectMapStation(station));
    }

    map.on("tileerror", () => {
      mapStatus.textContent = "Map tiles are unavailable; route search still works.";
    });
    mapStatus.textContent = "Tap a station marker to choose From, then To.";
    requestAnimationFrame(() => map.invalidateSize());
  } catch (error) {
    map = null;
    mapRouteLayer = null;
    mapStatus.textContent = `Map unavailable: ${error.message}. Route search still works.`;
  }
}

function selectMapStation(station) {
  if (nextMapSelection === "source") {
    sourceSelect.value = station.name;
    nextMapSelection = "destination";
    mapStatus.textContent = `${station.name} selected as From. Tap a station for To.`;
    return;
  }

  destinationSelect.value = station.name;
  nextMapSelection = "source";
  mapStatus.textContent = `${station.name} selected as To. Select another pair or find the route.`;
}

function clearRouteMap() {
  if (mapRouteLayer) {
    mapRouteLayer.clearLayers();
  }
}

function drawRouteOnMap(path, colors) {
  if (!map || !mapRouteLayer) {
    return;
  }

  try {
    mapRouteLayer.clearLayers();
    let runStart = 0;
    for (let edge = 1; edge <= colors.length; edge += 1) {
      if (edge === colors.length || colors[edge] !== colors[runStart]) {
        const run = path
          .slice(runStart, edge + 1)
          .map((stationId) => stationsById.get(stationId))
          .filter((station) => Number.isFinite(station.lat) && Number.isFinite(station.lng))
          .map((station) => [station.lat, station.lng]);
        if (run.length > 1) {
          window.L.polyline(run, {
            color: getLineStyle(colors[runStart]).hex,
            weight: 7,
            opacity: 0.9,
          }).addTo(mapRouteLayer);
        }
        runStart = edge;
      }
    }

    const interchangeIndexes = new Set();
    for (let index = 1; index < colors.length; index += 1) {
      if (colors[index - 1] !== colors[index]) {
        interchangeIndexes.add(index);
      }
    }

    path.forEach((stationId, index) => {
      const station = stationsById.get(stationId);
      if (!Number.isFinite(station.lat) || !Number.isFinite(station.lng)) {
        return;
      }
      const isStart = index === 0;
      const isEnd = index === path.length - 1;
      const isInterchange = interchangeIndexes.has(index);
      if (!isStart && !isEnd && !isInterchange) {
        return;
      }
      window.L.circleMarker([station.lat, station.lng], {
        radius: isStart || isEnd ? 9 : 8,
        color: "#ffffff",
        weight: 2,
        fillColor: isStart
          ? "#23834a"
          : isEnd
            ? "#c33b3b"
            : "#e4a500",
        fillOpacity: 1,
      })
        .bindPopup(station.name)
        .addTo(mapRouteLayer);
    });

    const bounds = path
      .map((stationId) => stationsById.get(stationId))
      .filter((station) => Number.isFinite(station.lat) && Number.isFinite(station.lng))
      .map((station) => [station.lat, station.lng]);
    if (bounds.length > 1) {
      map.fitBounds(bounds, { padding: [28, 28] });
    } else if (bounds.length === 1) {
      map.setView(bounds[0], 14);
    }
    map.invalidateSize();
  } catch (error) {
    mapStatus.textContent = `Could not draw the map route: ${error.message}. Route details are shown above.`;
  }
}

function showRouteError(message) {
  resultMessage.textContent = message;
  routeDetails.hidden = true;
  airportFareNote.hidden = true;
  clearRouteMap();
}

function findShortestPath(sourceId, destinationId) {
  const queue = [sourceId];
  const previous = new Map([[sourceId, null]]);

  // Breadth-first search finds a path with the fewest station-to-station stops.
  for (let index = 0; index < queue.length; index += 1) {
    const stationId = queue[index];
    if (stationId === destinationId) {
      break;
    }
    const neighbors = graph.get(stationId) || new Map();
    for (const neighborId of neighbors.keys()) {
      if (!previous.has(neighborId)) {
        previous.set(neighborId, stationId);
        queue.push(neighborId);
      }
    }
  }

  if (!previous.has(destinationId)) {
    return null;
  }

  const path = [];
  for (let stationId = destinationId; stationId !== null; stationId = previous.get(stationId)) {
    path.push(stationId);
  }
  return path.reverse();
}

function chooseSegmentColors(path) {
  const edgeColors = [];
  for (let index = 0; index < path.length - 1; index += 1) {
    const colors = graph.get(path[index]).get(path[index + 1]);
    edgeColors.push([...colors].sort());
  }

  if (edgeColors.length === 0) {
    return [];
  }

  // Keep the same color across shared-direction routes when possible.
  let costs = new Map(edgeColors[0].map((color) => [color, 0]));
  const parents = [];
  for (let index = 1; index < edgeColors.length; index += 1) {
    const nextCosts = new Map();
    const previousColors = new Map();
    for (const color of edgeColors[index]) {
      let bestCost = Infinity;
      let bestPrevious = null;
      for (const [previousColor, cost] of costs) {
        const changeCost = previousColor === color ? 0 : 1;
        if (cost + changeCost < bestCost) {
          bestCost = cost + changeCost;
          bestPrevious = previousColor;
        }
      }
      nextCosts.set(color, bestCost);
      previousColors.set(color, bestPrevious);
    }
    parents.push(previousColors);
    costs = nextCosts;
  }

  let color = [...costs].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0][0];
  const chosen = [color];
  for (let index = parents.length - 1; index >= 0; index -= 1) {
    color = parents[index].get(color);
    chosen.push(color);
  }
  return chosen.reverse();
}

function showRoute(sourceId, destinationId) {
  if (sourceId === destinationId) {
    showRouteError("Choose two different stations to find a route.");
    return;
  }

  const path = findShortestPath(sourceId, destinationId);
  if (!path) {
    showRouteError("No route was found between those stations. Try another pair.");
    return;
  }

  const colors = chooseSegmentColors(path);
  const travelMinutes = getTravelMinutes(path, colors);
  const distanceKm = getRouteDistanceKm(path);
  const fare = getFare(distanceKm);
  const nextTrains = getNextTrainMessages(path[0], path[1], colors[0]);
  routeList.replaceChildren();
  path.forEach((stationId, index) => {
    const station = stationsById.get(stationId);
    const isInterchange =
      index > 0 && index < colors.length && colors[index] !== colors[index - 1];
    const step = document.createElement("li");
    step.className = "route-step";

    const dot = document.createElement("span");
    dot.className = "route-dot";
    if (index === 0) {
      dot.classList.add("start");
    } else if (index === path.length - 1) {
      dot.classList.add("end");
    } else if (isInterchange) {
      dot.classList.add("interchange");
    } else {
      dot.style.backgroundColor = getLineStyle(colors[index]).hex;
      dot.style.boxShadow = `0 0 0 2px ${getLineStyle(colors[index]).hex}`;
    }
    dot.setAttribute("aria-hidden", "true");
    step.append(dot);

    const stationDetails = document.createElement("div");
    stationDetails.className = "route-station";
    stationDetails.append(document.createTextNode(station.name));
    if (isInterchange) {
      const marker = document.createElement("span");
      marker.className = "change-here";
      marker.textContent = "Change here";
      stationDetails.append(document.createElement("br"), marker);
    }
    step.append(stationDetails);

    if (index < path.length - 1) {
      const lineStyle = getLineStyle(colors[index]);
      const connector = document.createElement("div");
      connector.className = "route-connector";
      connector.style.setProperty("--line-color", lineStyle.hex);
      const lineName = document.createElement("span");
      lineName.className = "line-badge";
      lineName.textContent = `${lineStyle.name} line`;
      lineName.style.backgroundColor = lineStyle.hex;
      lineName.style.color = colors[index] === "YELLOW" ? "#172033" : "#ffffff";
      connector.append(lineName);
      step.append(connector);
    }
    routeList.append(step);
  });

  totalStopsElement.textContent = String(path.length - 1);
  travelTimeElement.textContent = travelMinutes === null
    ? "Unavailable"
    : `about ${Math.round(travelMinutes)} min`;
  estimatedFareElement.textContent = fare === null ? "Unavailable" : `₹${fare.tokenFare}`;
  fareDayLabelElement.textContent = fare ? fare.dayLabel : "";
  smartCardFareElement.textContent = fare
    ? `${fare.smartCardLabel}: ₹${fare.smartCardFare}`
    : "";
  fareDistanceElement.textContent = distanceKm === null
    ? "Distance unavailable"
    : `Distance: about ${distanceKm.toFixed(1)} km`;
  airportFareNote.hidden = !colors.includes("ORANGE/AIRPORT");
  nextTrainsElement.replaceChildren();
  for (const message of nextTrains) {
    const times = [...message.matchAll(/\b\d{2}:\d{2}\b/g)].map((match) => match[0]);
    const note = message
      .replace(/\b\d{2}:\d{2}\b/g, "")
      .replace(/\(Scheduled, approximate\)\.?/g, "")
      .replace(/(?:,\s*){2,}/g, " ")
      .replace(/\s{2,}/g, " ")
      .replace(/[\s,.:;]+$/g, "")
      .trim();
    if (note) {
      const noteElement = document.createElement("span");
      noteElement.className = "train-note";
      noteElement.textContent = note;
      nextTrainsElement.append(noteElement);
    }
    for (const time of times) {
      const chip = document.createElement("span");
      chip.className = "train-chip";
      chip.textContent = time;
      nextTrainsElement.append(chip);
    }
  }
  resultMessage.textContent = "Shortest route found. Fare is a distance-based estimate.";
  routeDetails.hidden = false;
  drawRouteOnMap(path, colors);
}

routeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const sourceId = getStationId(sourceSelect);
  const destinationId = getStationId(destinationSelect);
  if (!sourceId || !destinationId) {
    showRouteError("Choose a station from the suggestions for both fields.");
    return;
  }
  showRoute(sourceId, destinationId);
});

swapButton.addEventListener("click", () => {
  const sourceName = sourceSelect.value;
  sourceSelect.value = destinationSelect.value;
  destinationSelect.value = sourceName;
  const sourceId = getStationId(sourceSelect);
  const destinationId = getStationId(destinationSelect);
  if (sourceId && destinationId) {
    showRoute(sourceId, destinationId);
  }
});

async function loadData() {
  try {
    const [stationsResponse, linesResponse, timingsResponse, segmentsResponse, faresResponse] = await Promise.all([
      fetch("data/stations.json"),
      fetch("data/lines.json"),
      fetch("data/timings.json"),
      fetch("data/segments.json"),
      fetch("data/fares.json"),
    ]);
    if (
      !stationsResponse.ok ||
      !linesResponse.ok ||
      !timingsResponse.ok ||
      !segmentsResponse.ok ||
      !faresResponse.ok
    ) {
      throw new Error("Could not load one or more metro data files.");
    }

    const [stations, lines, timings, segments, fares] = await Promise.all([
      stationsResponse.json(),
      linesResponse.json(),
      timingsResponse.json(),
      segmentsResponse.json(),
      faresResponse.json(),
    ]);
    timingData = timings;
    segmentData = segments;
    fareData = fares;
    populateStationOptions(stations);
    buildGraph(lines);
    findRouteButton.disabled = false;
    resultMessage.textContent = "Choose a source and destination station.";
    initializeMap(stations);
  } catch (error) {
    resultMessage.textContent = `Could not load metro data: ${error.message}`;
  }
}

loadData();