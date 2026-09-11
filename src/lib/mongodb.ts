import type { EmergencyCase, EmergencySeverity, AlertLifecycleStep } from "./mock-data";

const BASE = (import.meta.env["VITE_API_URL"] as string | undefined) || "";
const LS_KEY = "carecast_emergencies";

// ── Types ──────────────────────────────────────────────────────────────────

export type PatientReport = {
  caseId: string;
  patientId: string;
  incidentType: string;
  patientName: string;
  patientAge: number;
  contactNumber: string;
  location: string;
  severity: EmergencySeverity;
  description: string;
  resources?: string[];
  lifecycle: AlertLifecycleStep;
  reportedAt: string;
};

// ── localStorage helpers ───────────────────────────────────────────────────

function lsLoad(): PatientReport[] {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? "[]") as PatientReport[];
  } catch {
    return [];
  }
}

function lsSave(reports: PatientReport[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(reports));
}

// ── API helper ─────────────────────────────────────────────────────────────

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ── Emergency CRUD (backend-first, localStorage fallback) ──────────────────

export async function insertEmergency(report: PatientReport): Promise<PatientReport> {
  try {
    const saved = await api<PatientReport>("/api/emergencies", {
      method: "POST",
      body: JSON.stringify(report),
    });
    // Also persist locally so it survives backend restarts
    const existing = lsLoad();
    lsSave([saved, ...existing.filter((r) => r.caseId !== saved.caseId)]);
    return saved;
  } catch {
    // Backend offline — save to localStorage only
    const existing = lsLoad();
    const updated = [report, ...existing.filter((r) => r.caseId !== report.caseId)];
    lsSave(updated);
    return report;
  }
}

export async function fetchEmergencies(patientId?: string): Promise<PatientReport[]> {
  // Always return localStorage immediately — never block on backend
  const local = lsLoad();
  const localFiltered = patientId ? local.filter((r) => r.patientId === patientId) : local;
  // Fire-and-forget backend sync in background
  const qs = patientId ? `?patient_id=${encodeURIComponent(patientId)}` : "";
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 2000);
  fetch(`${BASE}/api/emergencies${qs}`, { signal: ctrl.signal, headers: { "Content-Type": "application/json" } })
    .then((res) => res.ok ? res.json() as Promise<{ emergencies: PatientReport[] }> : Promise.reject())
    .then((data) => {
      const serverIds = new Set(data.emergencies.map((r: PatientReport) => r.caseId));
      const localOnly = local.filter((r) => !serverIds.has(r.caseId));
      lsSave([...localOnly, ...data.emergencies]);
    })
    .catch(() => { /* backend offline — local data is already returned */ });
  return localFiltered;
}

export async function updateLifecycle(caseId: string, lifecycle: AlertLifecycleStep): Promise<void> {
  // Update localStorage immediately
  const existing = lsLoad();
  lsSave(existing.map((r) => (r.caseId === caseId ? { ...r, lifecycle } : r)));
  try {
    await api(`/api/emergencies/${encodeURIComponent(caseId)}/lifecycle`, {
      method: "PATCH",
      body: JSON.stringify({ lifecycle }),
    });
  } catch {
    // Silently keep local update when backend is offline
  }
}

// ── Convert PatientReport → EmergencyCase ─────────────────────────────────

export function reportToEmergencyCase(r: PatientReport): EmergencyCase {
  return {
    id: r.caseId,
    incidentType: r.incidentType,
    patientCount: 1,
    severity: r.severity,
    etaMinutes: 10,
    location: r.location,
    injurySummary: r.description || "Patient-reported emergency.",
    triage: {
      critical: r.severity === "CRITICAL" ? 1 : 0,
      urgent: r.severity === "HIGH" ? 1 : 0,
      delayed: 0,
    },
    vitalsPreview: `Patient: ${r.patientName}, Age: ${r.patientAge}`,
    lifecycle: r.lifecycle,
    reportedAt: r.reportedAt,
    hospitalRisk: r.severity === "CRITICAL" ? "CRITICAL" : r.severity === "HIGH" ? "LIMITED" : "READY",
    roles: [
      {
        id: "r1",
        role: "Emergency Doctor",
        department: "Emergency Dept",
        assignee: "On-Duty Trauma Attending",
        status: "PENDING",
        action: "Assess incoming patient and prepare resuscitation bay",
        urgency: "CRITICAL",
      },
      {
        id: "r2",
        role: "Hospital Emergency Coordinator",
        department: "Command Ops",
        assignee: "M. ADITHYA (Admin Coordinator)",
        status: "PENDING",
        action: "Coordinate bed availability and resource allocation",
        urgency: "HIGH",
      },
    ],
    escalation: [
      { tier: 1, level: "Primary Tier", role: "Emergency Doctor", name: "On-Duty Attending", contact: "Ext. 4401", timeoutSeconds: 60, status: "ACTIVE" },
      { tier: 2, level: "Command Escalation", role: "Hospital Emergency Coordinator", name: "M. ADITHYA", contact: "Command Desk #1", timeoutSeconds: 120, status: "PENDING" },
    ],
  };
}
