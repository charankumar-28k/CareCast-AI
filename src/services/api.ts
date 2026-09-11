import type {
  DashboardResponse,
  ForecastResponse,
  BottlenecksResponse,
  ResourcesResponse,
  DependenciesResponse,
  SimulateRequest,
  SimulateResponse,
  RecommendationsResponse,
  ProcedureCapacityResponse,
  ApiProcedure,
  SchedulingConflict,
  EmergencyReportIn,
} from "@/types/api";

import {
  hospital as mockHospital,
  resources as mockResources,
  departments as mockDepartments,
  forecast as mockForecast,
  bottlenecks as mockBottlenecks,
  recommendations as mockRecommendations,
  networkNodes as mockNodes,
  networkEdges as mockEdges,
  api as mockApi,
} from "@/lib/mock-data";

// ── Config ────────────────────────────────────────────────────────────────────

export const API_BASE = (import.meta.env["VITE_API_URL"] as string | undefined) ?? "";
const TIMEOUT_MS = 8000;

// ── Connection status ─────────────────────────────────────────────────────────

let _backendOnline = false;

export function isBackendOnline() {
  return _backendOnline;
}

export async function checkBackendHealth(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(`${API_BASE}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) { _backendOnline = false; return false; }
    const json = await res.json() as { status?: string };
    _backendOnline = json.status === "online" || json.status === "ok";
  } catch {
    _backendOnline = false;
  }
  return _backendOnline;
}

// ── Core fetch helper ─────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", ...options?.headers },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _backendOnline = true;
    return res.json() as Promise<T>;
  } catch (err) {
    clearTimeout(timer);
    _backendOnline = false;
    throw err;
  }
}

// ── GET /api/dashboard ────────────────────────────────────────────────────────

export async function fetchDashboard(): Promise<DashboardResponse> {
  try {
    return await apiFetch<DashboardResponse>("/api/dashboard");
  } catch {
    return {
      hospital: {
        name: mockHospital.name,
        capacity_score: mockHospital.capacityScore,
        current_utilization: mockHospital.currentUtilization,
        predicted_peak: mockHospital.predictedPeak,
        time_to_critical: mockHospital.timeToCritical,
        risk: "MODERATE",
        last_updated: mockHospital.lastUpdated,
      },
      resources: mockResources.map((r) => ({ ...r })),
      departments: mockDepartments,
      forecast: mockForecast,
      bottlenecks: mockBottlenecks.map((b) => ({
        ...b,
        risk: b.risk as import("@/types/api").RiskLevel,
      })),
      recommendations: mockRecommendations,
    };
  }
}

// ── GET /api/resources ────────────────────────────────────────────────────────

// Normalise a raw backend resource record to the internal ApiResource shape.
// Backend may return { resource, current_usage, forecast_usage, capacity (number) }
function normaliseResource(raw: Record<string, unknown>, index: number): import("@/types/api").ApiResource {
  const mockFallback = mockResources[index % mockResources.length] ?? mockResources[0]!;
  const name = String(raw["resource"] ?? raw["name"] ?? mockFallback.name);
  const utilization = Number(raw["current_usage"] ?? raw["utilization"] ?? mockFallback.utilization);
  const forecastUsage = Number(raw["forecast_usage"] ?? raw["forecast"] ?? utilization);
  const capacityRaw = raw["capacity"];
  const capacity =
    typeof capacityRaw === "number"
      ? `${capacityRaw} units`
      : typeof capacityRaw === "string"
      ? capacityRaw
      : mockFallback.capacity;
  const trend = String(raw["trend"] ?? mockFallback.trend);
  const risk = (raw["risk"] ?? (utilization >= 90 ? "CRITICAL" : utilization >= 80 ? "HIGH" : utilization >= 65 ? "MODERATE" : utilization >= 50 ? "NORMAL" : "LOW")) as import("@/types/api").RiskLevel;
  const sparkline = Array.isArray(raw["sparkline"]) ? (raw["sparkline"] as number[]) : mockFallback.sparkline;
  return {
    name,
    department: String(raw["department"] ?? mockFallback.department),
    utilization,
    forecast_usage: forecastUsage,
    capacity,
    trend,
    risk,
    icon: String(raw["icon"] ?? mockFallback.icon ?? ""),
    sparkline,
  };
}

export async function fetchResources(): Promise<ResourcesResponse> {
  try {
    const raw = await apiFetch<unknown>("/api/resources");
    // Backend may return a plain array or the wrapped object shape
    const rawList: Record<string, unknown>[] = Array.isArray(raw)
      ? (raw as Record<string, unknown>[])
      : ((raw as Record<string, unknown>)["resources"] as Record<string, unknown>[] ?? []);
    const normalised = rawList.map((r, i) => normaliseResource(r, i));
    const peakForecast = typeof (raw as Record<string, unknown>)["hospital_peak_forecast"] === "number"
      ? (raw as Record<string, unknown>)["hospital_peak_forecast"] as number
      : mockHospital.predictedPeak;
    return {
      resources: normalised,
      underutilized: normalised.filter((r) => r.utilization < 55),
      hospital_peak_forecast: peakForecast,
    };
  } catch {
    return {
      resources: mockResources.map((r) => ({ ...r })),
      underutilized: mockResources.filter((r) => r.utilization < 55),
      hospital_peak_forecast: mockHospital.predictedPeak,
    };
  }
}

// ── GET /api/forecast ─────────────────────────────────────────────────────────

export async function fetchForecast(horizon = 8): Promise<ForecastResponse> {
  try {
    return await apiFetch<ForecastResponse>(`/api/forecast?horizon=${horizon}`);
  } catch {
    const peak = Math.max(...mockForecast.map((p) => p.forecast));
    return {
      points: mockForecast,
      peak_demand: peak,
      peak_time: "+8h",
      capacity_remaining: Math.max(0, 100 - peak),
      risk: "HIGH",
      confidence: 0.924,
      factors: [
        { label: "Recent patient arrivals",    impact: "High impact",   weight: 88 },
        { label: "Historical hourly pattern",  impact: "Medium impact", weight: 64 },
        { label: "Scheduled procedures",       impact: "Medium impact", weight: 58 },
        { label: "Current occupancy baseline", impact: "High impact",   weight: 82 },
        { label: "Diagnostic demand (CT/Lab)", impact: "Low impact",    weight: 34 },
      ],
    };
  }
}

// ── GET /api/bottlenecks ──────────────────────────────────────────────────────

// Normalise a raw backend bottleneck record to the internal ApiBottleneck shape.
// The backend may return { predicted, capacity (number) } while the UI expects
// { peak, capacity (string) }.
function normaliseBottleneck(raw: Record<string, unknown>): import("@/types/api").ApiBottleneck {
  const peak = (raw["peak"] ?? raw["predicted"] ?? 0) as number;
  const capacityRaw = raw["capacity"];
  const capacity =
    typeof capacityRaw === "number"
      ? `${capacityRaw}`
      : typeof capacityRaw === "string"
      ? capacityRaw
      : "—";
  return {
    resource:   String(raw["resource"]   ?? ""),
    department: String(raw["department"] ?? ""),
    current:    Number(raw["current"]    ?? 0),
    peak,
    capacity,
    time:       String(raw["time"]       ?? "—"),
    risk:       (raw["risk"] ?? "MODERATE") as import("@/types/api").RiskLevel,
    impact:     String(raw["impact"]     ?? ""),
  };
}

export async function fetchBottlenecks(): Promise<BottlenecksResponse> {
  try {
    const raw = await apiFetch<{ count?: number; bottlenecks?: Record<string, unknown>[]; timeline?: import("@/types/api").ApiBottleneckTimelinePoint[] }>("/api/bottlenecks");
    // Backend may return a plain array or the wrapped object shape
    const rawList: Record<string, unknown>[] = Array.isArray(raw)
      ? (raw as Record<string, unknown>[])
      : (raw.bottlenecks ?? []);
    const bottlenecks = rawList.map(normaliseBottleneck);
    return {
      count: raw.count ?? bottlenecks.length,
      bottlenecks,
      timeline: raw.timeline ?? [
        { time: "Now",  emergency: 88.0, ct: 91.0, ward: 87.0, icu: 74.0 },
        { time: "+2H",  emergency: 91.0, ct: 93.4, ward: 88.6, icu: 75.2 },
        { time: "+4H",  emergency: 94.0, ct: 95.8, ward: 90.2, icu: 76.4 },
        { time: "+6H",  emergency: 97.0, ct: 98.2, ward: 91.8, icu: 77.6 },
        { time: "+12H", emergency: 103.5, ct: 104.2, ward: 95.8, icu: 80.6 },
      ],
    };
  } catch {
    return {
      count: mockBottlenecks.length,
      bottlenecks: mockBottlenecks.map((b) => ({
        ...b,
        risk: b.risk as import("@/types/api").RiskLevel,
      })),
      timeline: [
        { time: "Now",  emergency: 88.0, ct: 91.0, ward: 87.0, icu: 74.0 },
        { time: "+2H",  emergency: 91.0, ct: 93.4, ward: 88.6, icu: 75.2 },
        { time: "+4H",  emergency: 94.0, ct: 95.8, ward: 90.2, icu: 76.4 },
        { time: "+6H",  emergency: 97.0, ct: 98.2, ward: 91.8, icu: 77.6 },
        { time: "+12H", emergency: 103.5, ct: 104.2, ward: 95.8, icu: 80.6 },
      ],
    };
  }
}

// ── GET /api/dependencies ─────────────────────────────────────────────────────

// Auto-layout positions for nodes that arrive without x/y coordinates.
const NODE_LAYOUT: Record<string, { x: number; y: number }> = {
  arrival:   { x: 8,  y: 46 },
  emergency: { x: 27, y: 20 },
  beds:      { x: 49, y: 20 },
  ct:        { x: 49, y: 47 },
  lab:       { x: 49, y: 74 },
  diagnosis: { x: 69, y: 47 },
  treatment: { x: 84, y: 47 },
  ward:      { x: 69, y: 20 },
  icu:       { x: 84, y: 20 },
  discharge: { x: 94, y: 20 },
};

function normaliseNode(raw: Record<string, unknown>, index: number): import("@/types/api").ApiNetworkNode {
  const id = String(raw["id"] ?? "");
  const fallback = NODE_LAYOUT[id.toLowerCase()] ?? { x: (index % 5) * 20 + 10, y: Math.floor(index / 5) * 30 + 20 };
  const util = raw["utilization"];
  const riskVal = raw["risk"];
  const node: import("@/types/api").ApiNetworkNode = {
    id,
    label: String(raw["label"] ?? raw["id"] ?? id),
    x:     typeof raw["x"] === "number" ? raw["x"] : fallback.x,
    y:     typeof raw["y"] === "number" ? raw["y"] : fallback.y,
    kind:  String(raw["kind"] ?? "normal"),
  };
  if (typeof util === "number") node.utilization = util;
  if (riskVal != null) node.risk = String(riskVal);
  return node;
}

function normaliseEdge(raw: Record<string, unknown>): import("@/types/api").ApiNetworkEdge {
  // strength may arrive as a number (0.91) or string ("91%")
  const s = raw["strength"];
  const strength =
    typeof s === "number"
      ? `${Math.round(s * 100)}%`
      : typeof s === "string"
      ? s
      : "—";
  return {
    source:   String(raw["source"] ?? ""),
    target:   String(raw["target"] ?? ""),
    strength,
  };
}

export async function fetchDependencies(nodeId?: string): Promise<DependenciesResponse> {
  try {
    const qs = nodeId ? `?node_id=${nodeId}` : "";
    const raw = await apiFetch<Record<string, unknown>>(`/api/dependencies${qs}`);
    const rawNodes = (Array.isArray(raw["nodes"]) ? raw["nodes"] : []) as Record<string, unknown>[];
    const rawEdges = (Array.isArray(raw["edges"]) ? raw["edges"] : []) as Record<string, unknown>[];
    const result: DependenciesResponse = {
      nodes: rawNodes.map((n, i) => normaliseNode(n, i)),
      edges: rawEdges.map(normaliseEdge),
    };
    const prop = raw["propagation"];
    if (prop != null) result.propagation = prop as import("@/types/api").PropagationResponse;
    return result;
  } catch {
    const edges = mockEdges.map(([source, target, strength]) => ({ source, target, strength }));
    return { nodes: mockNodes, edges };
  }
}

// ── POST /api/simulate ────────────────────────────────────────────────────────

export async function postSimulate(req: SimulateRequest): Promise<SimulateResponse> {
  try {
    const raw = await apiFetch<Record<string, unknown>>("/api/simulate", {
      method: "POST",
      body: JSON.stringify(req),
    });
    // Normalise: backend may return risk_level instead of risk
    const risk = (raw["risk"] ?? raw["risk_level"] ?? "MODERATE") as SimulateResponse["risk"];
    const rawResources = (raw["resources"] ?? {}) as Record<string, unknown>;
    // Normalise recommendations: backend returns plain strings
    const rawRecs = Array.isArray(raw["recommendations"]) ? raw["recommendations"] as unknown[] : [];
    const recommendations: SimulateResponse["recommendations"] = rawRecs.map((r) =>
      typeof r === "string"
        ? { priority: "ACTION", title: r, reason: "", impact: "HIGH", improvement: "" }
        : r as import("@/types/api").ApiRecommendation
    );
    const resources: SimulateResponse["resources"] = {
      beds:       Number(rawResources["beds"]       ?? 0),
      emergency:  Number(rawResources["emergency"]  ?? 0),
      ct:         Number(rawResources["ct"]         ?? 0),
      laboratory: Number(rawResources["laboratory"] ?? 0),
      icu:        Number(rawResources["icu"]        ?? 0),
    };
    if (typeof rawResources["mri"] === "number") resources.mri = rawResources["mri"] as number;

    // Extract live baseline (before) values if backend provides them
    const rawBefore = (raw["before"] ?? {}) as Record<string, unknown>;
    const before: SimulateResponse["before"] = {
      beds:       Number(rawBefore["beds"]       ?? resources.beds),
      emergency:  Number(rawBefore["emergency"]  ?? resources.emergency),
      ct:         Number(rawBefore["ct"]         ?? resources.ct),
      laboratory: Number(rawBefore["laboratory"] ?? resources.laboratory),
      icu:        Number(rawBefore["icu"]        ?? resources.icu),
    };
    if (typeof rawBefore["mri"] === "number") before.mri = rawBefore["mri"] as number;

    return {
      risk,
      hospital_score: typeof raw["hospital_score"] === "number" ? raw["hospital_score"] : Math.max(0, Math.round(100 - Number(raw["risk_score"] ?? 0) * 0.4)),
      before,
      resources,
      bottlenecks: Array.isArray(raw["bottlenecks"]) ? raw["bottlenecks"] as string[] : [],
      recommendations,
    };
  } catch {
    const result = mockApi.getScenario(req.patient_surge);
    const maxVal = Math.max(...Object.values(result));
    return {
      risk: maxVal > 100 ? "CRITICAL" : maxVal > 90 ? "HIGH" : "MODERATE",
      hospital_score: Math.max(0, Math.round(100 - maxVal * 0.4)),
      resources: result,
      bottlenecks: [],
      recommendations: mockRecommendations,
    };
  }
}

// ── GET /api/recommendations ──────────────────────────────────────────────────

export async function fetchRecommendations(): Promise<RecommendationsResponse> {
  try {
    const raw = await apiFetch<{ recommendations?: unknown[] } | unknown[]>("/api/recommendations");
    const list: unknown[] = Array.isArray(raw) ? raw : ((raw as { recommendations?: unknown[] }).recommendations ?? []);
    const recommendations = list.map((r) => {
      const rec = r as Record<string, unknown>;
      // Normalise: backend may send `action` instead of `title`
      const title = String(rec["title"] ?? rec["action"] ?? "");
      const action = String(rec["action"] ?? title);
      return {
        priority:    String(rec["priority"]    ?? "ACTION"),
        title,
        action,
        reason:      String(rec["reason"]      ?? ""),
        impact:      String(rec["impact"]      ?? "MEDIUM"),
        improvement: String(rec["improvement"] ?? ""),
      } satisfies import("@/types/api").ApiRecommendation;
    });
    return { recommendations };
  } catch {
    return { recommendations: mockRecommendations };
  }
}

// ── GET /api/procedure-capacity ───────────────────────────────────────────────

export async function fetchProcedureCapacity(): Promise<ProcedureCapacityResponse> {
  return apiFetch<ProcedureCapacityResponse>("/api/procedure-capacity");
}

// ── GET /api/procedures ───────────────────────────────────────────────────────

export async function fetchProcedures(): Promise<ApiProcedure[]> {
  const raw = await apiFetch<ApiProcedure[] | { procedures: ApiProcedure[] }>("/api/procedures");
  return Array.isArray(raw) ? raw : raw.procedures ?? [];
}

// ── GET /api/scheduling-conflicts ────────────────────────────────────────────

export async function fetchSchedulingConflicts(): Promise<SchedulingConflict[]> {
  const raw = await apiFetch<SchedulingConflict[] | { conflicts: SchedulingConflict[] }>("/api/scheduling-conflicts");
  return Array.isArray(raw) ? raw : raw.conflicts ?? [];
}

// ── POST /api/procedures ─────────────────────────────────────────────────────

export interface CreateProcedureRequest {
  type: string;
  department: string;
  scheduled_time: string;
  duration: string;
  priority: string;
  required_resources: string[];
}

export async function postProcedure(body: CreateProcedureRequest): Promise<ApiProcedure> {
  try {
    return await apiFetch<ApiProcedure>("/api/procedures", {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch {
    // Offline fallback: return a mock procedure with a generated id
    return {
      id: `PROC-${Date.now()}`,
      type: body.type,
      department: body.department,
      scheduled_time: body.scheduled_time,
      duration: body.duration,
      priority: body.priority,
      status: "SCHEDULED",
      required_resources: body.required_resources,
    };
  }
}

// ── POST /api/emergencies ─────────────────────────────────────────────────────

export async function postEmergency(body: EmergencyReportIn): Promise<EmergencyReportIn> {
  return apiFetch<EmergencyReportIn>("/api/emergencies", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
