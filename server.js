// Run: ANTHROPIC_API_KEY=your_key node server.js   (Node 18 or newer, no npm install needed)
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const PORT = process.env.PORT || 3000;

const SYSTEM = `You are the assistant inside NearHelp, an app that helps people find nearby hospitals, police stations, petrol pumps, taxis and hostels.
Reply in the same language the user writes in (English, Urdu or Sindhi). Be short and calm.
Pick the one category that fits the request: hospital, police, pump, taxi, hostel, mechanic (vehicle repair shop), pharmacy (medical store), or none.
Never give medical advice or diagnoses. For urgent medical situations tell the user to call 1122 first; for danger or crime, call 15.
You may use the nearby list given by the app, but never invent places or phone numbers.
Return ONLY JSON: {"category":"hospital|police|pump|taxi|hostel|mechanic|pharmacy|none","reply":"one or two short sentences"}`;

async function chat(message, nearby) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5-5",
      max_tokens: 300,
      system: SYSTEM,
      messages: [{ role: "user", content: `Nearby: ${nearby || "unknown"}\nUser: ${message}` }],
    }),
  });
  if (!r.ok) throw new Error("API " + r.status);
  const data = await r.json();
  const text = data.content.map((c) => c.text || "").join("").replace(/```json|```/g, "").trim();
  return JSON.parse(text);
}

const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

function buildQuery(lat, lon, r) {
  const a = `(around:${r},${lat},${lon})`;
  const f = (k, v) => `nwr["${k}"="${v}"]${a};`;
  return `[out:json][timeout:10];(${f("amenity","hospital")}${f("amenity","clinic")}${f("amenity","police")}${f("amenity","fuel")}${f("amenity","taxi")}${f("tourism","hostel")}${f("tourism","guest_house")}${f("amenity","pharmacy")}${f("shop","car_repair")}${f("shop","motorcycle_repair")}${f("shop","tyres")});out center tags 150;`;
}

async function overpass(lat, lon, r) {
  const q = buildQuery(lat, lon, r);
  for (const m of MIRRORS.slice(0, 2)) {
    try {
      const res = await fetch(m, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "NearHelp-hackathon/1.0", accept: "application/json" },
        body: "data=" + encodeURIComponent(q),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return await res.json();
      console.log("Overpass:", m, "returned", res.status);
    } catch (e) {
      console.log("Overpass:", m, "failed:", e.message);
    }
  }
  throw new Error("overpass failed");
}

// Backup source (Nominatim): lighter, fewer details (no phone numbers)
async function nominatim(lat, lon, r) {
  const dLat = r / 111000, dLon = r / (111000 * Math.cos((lat * Math.PI) / 180));
  const vb = [lon - dLon, lat + dLat, lon + dLon, lat - dLat].join(",");
  const T = [["hospital", { amenity: "hospital" }], ["police", { amenity: "police" }], ["petrol station", { amenity: "fuel" }], ["taxi", { amenity: "taxi" }], ["hostel", { tourism: "hostel" }], ["pharmacy", { amenity: "pharmacy" }], ["car repair", { shop: "car_repair" }]];
  const els = [];
  for (const [term, tags] of T) {
    try {
      const res = await fetch("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=20&bounded=1&viewbox=" + vb + "&q=" + encodeURIComponent(term), {
        headers: { "user-agent": "NearHelp-hackathon/1.0" },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) for (const p of await res.json()) els.push({ type: "nom", id: p.place_id, lat: +p.lat, lon: +p.lon, tags: Object.assign({ name: p.name || undefined }, tags) });
      else console.log("Nominatim:", term, "returned", res.status);
    } catch (e) {
      console.log("Nominatim:", term, "failed:", e.message);
    }
    await new Promise((x) => setTimeout(x, 1100));
  }
  if (!els.length) throw new Error("nominatim empty");
  return { elements: els };
}

const CFILE = path.join(__dirname, "community.json");
const TYPES = ["hospital", "police", "pump", "taxi", "hostel", "mechanic", "pharmacy"];
function readComm() {
  try {
    return JSON.parse(fs.readFileSync(CFILE, "utf8"));
  } catch (e) {
    return [];
  }
}

http
  .createServer(async (req, res) => {
    if (req.url === "/api/community" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(readComm()));
      return;
    }
    if (req.url === "/api/community" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const d = JSON.parse(body);
          const n = String(d.n || "").trim().slice(0, 80);
          const p = String(d.p || "").replace(/[^\d+\-\s()]/g, "").slice(0, 20);
          if (n.length < 2 || !TYPES.includes(d.t) || !Number.isFinite(d.lat) || !Number.isFinite(d.lon) || Math.abs(d.lat) > 90 || Math.abs(d.lon) > 180) throw new Error("bad input");
          const list = readComm();
          const item = { id: Date.now(), n, t: d.t, p, lat: d.lat, lon: d.lon };
          list.push(item);
          fs.writeFileSync(CFILE, JSON.stringify(list.slice(-2000)));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(item));
        } catch (e) {
          res.writeHead(400);
          res.end("{}");
        }
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/places") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const { lat, lon, r } = JSON.parse(body);
          if (![lat, lon, r].every(Number.isFinite) || r > 20000) throw new Error("bad input");
          const backup = nominatim(lat, lon, r);
          backup.catch(() => {});
          let out;
          try {
            out = await overpass(lat, lon, r);
          } catch (e) {
            console.log("Using backup source");
            out = await backup;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(out));
        } catch (e) {
          res.writeHead(502);
          res.end("{}");
        }
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/chat") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const { message, nearby } = JSON.parse(body);
          const out = await chat(String(message).slice(0, 500), String(nearby || "").slice(0, 800));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(out));
        } catch (e) {
          res.writeHead(500);
          res.end("{}");
        }
      });
      return;
    }
    const FILES = { "/manifest.webmanifest": "application/manifest+json", "/sw.js": "text/javascript", "/icon-192.png": "image/png", "/icon-512.png": "image/png" };
    const url = req.url.split("?")[0];
    const file = FILES[url] ? url.slice(1) : "index.html";
    fs.readFile(path.join(__dirname, file), (err, data) => {
      res.writeHead(err ? 500 : 200, { "content-type": FILES[url] || "text/html; charset=utf-8" });
      res.end(err ? "error" : data);
    });
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log("NearHelp running at http://localhost:" + PORT);
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
    if (lan) console.log("On your phone (same Wi-Fi): http://" + lan.address + ":" + PORT);
  });
