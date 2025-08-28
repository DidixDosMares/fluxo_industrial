"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  ReactNode,
} from "react";

/* ======================= Tipos e Constantes ======================= */

type Mode = "off" | "manual" | "auto" | "defect";
type GroupMode = "auto" | "manu";

const MODE = { OFF: "off", MANUAL: "manual", AUTO: "auto", DEFECT: "defect" } as const;
const GROUP_MODE = { AUTO: "auto", MANU: "manu" } as const;
const TIMER_SECONDS = 2;

const ORDER = [
  "TransportadorCorreia01",
  "MoinhoMarteloM1",
  "MoinhoMarteloM2",
  "ValvulaRotativa01",
  "TransportadorCorreia02",
  "CaliaVibratoria",
  "TransportadorCorreia03",
  "TransportadorCorreia04",
] as const;

type UnitKey = (typeof ORDER)[number];
type StateRecord = Record<UnitKey, Mode>;
type TimersRecord = Partial<Record<UnitKey, number>>;

const LABELS: Record<UnitKey, string> = {
  TransportadorCorreia01: "TC01",
  MoinhoMarteloM1: "MM01M1",
  MoinhoMarteloM2: "MM01M2",
  ValvulaRotativa01: "VR01",
  TransportadorCorreia02: "TC02",
  CaliaVibratoria: "CV01",
  TransportadorCorreia03: "TC03",
  TransportadorCorreia04: "TC04",
};

/* ======================= Contexto do Sistema ======================= */

interface Actions {
  clickButton: (key: UnitKey) => void;
  toggleDefect: (key: UnitKey) => void;
  setGroupMode: (nextMode: GroupMode) => void;
  groupPowerOn: () => void;
  groupPowerOff: () => void;
}

interface SystemContextValue {
  state: StateRecord;
  actions: Actions;
  timers: TimersRecord;
  groupMode: GroupMode;
  startupRun: boolean;
  shutdownRun: boolean;
}

const SystemContext = createContext<SystemContextValue | null>(null);

function makeInitialState(): StateRecord {
  const s = {} as StateRecord;
  ORDER.forEach((k) => (s[k] = MODE.OFF));
  return s;
}

function useSavedState<T>(key: string, initial: T) {
  const [val, setVal] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {}
  }, [key, val]);
  return [val, setVal] as const;
}

function SystemProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useSavedState<StateRecord>("flow_state", makeInitialState());
  const [timers, setTimers] = useSavedState<TimersRecord>("flow_timers", {});
  const [groupMode, setGroupMode] = useSavedState<GroupMode>("flow_group_mode", GROUP_MODE.AUTO);

  const [shutdownRun, setShutdownRun] = useSavedState<boolean>("flow_shutdown_active", false);
  const [startupRun, setStartupRun] = useSavedState<boolean>("flow_startup_active", false);

  useInterlocks(
    state,
    setState,
    timers,
    setTimers,
    groupMode,
    shutdownRun,
    setShutdownRun,
    startupRun,
    setStartupRun
  );

  const actions = useMemo(
    () =>
      createActions(
        state,
        setState,
        timers,
        setTimers,
        groupMode,
        setGroupMode,
        setShutdownRun,
        setStartupRun
      ),
    [state, timers, groupMode, setShutdownRun, setStartupRun, setGroupMode, setState, setTimers]
  );

  const value = useMemo<SystemContextValue>(
    () => ({ state, actions, timers, groupMode, startupRun, shutdownRun }),
    [state, actions, timers, groupMode, startupRun, shutdownRun]
  );

  return <SystemContext.Provider value={value}>{children}</SystemContext.Provider>;
}

function useSystem(): SystemContextValue {
  const ctx = useContext(SystemContext);
  if (!ctx) throw new Error("useSystem deve ser usado dentro de <SystemProvider>");
  return ctx;
}

/* ======================= Helpers de Topologia ======================= */

const idxOf = (k: UnitKey) => ORDER.indexOf(k);
const upstreamOf = (key: UnitKey): UnitKey[] => ORDER.slice(0, idxOf(key)) as UnitKey[];

const immediateDownstream = (key: UnitKey): UnitKey[] => {
  switch (key) {
    case "TransportadorCorreia01":
      return ["MoinhoMarteloM1", "MoinhoMarteloM2"];
    case "MoinhoMarteloM1":
    case "MoinhoMarteloM2":
      return ["ValvulaRotativa01"];
    case "ValvulaRotativa01":
      return ["TransportadorCorreia02"];
    case "TransportadorCorreia02":
      return ["CaliaVibratoria"];
    case "CaliaVibratoria":
      return ["TransportadorCorreia03", "TransportadorCorreia04"];
    default:
      return [];
  }
};
const immediateUpstream = (key: UnitKey): UnitKey[] => {
  switch (key) {
    case "MoinhoMarteloM1":
    case "MoinhoMarteloM2":
      return ["TransportadorCorreia01"];
    case "ValvulaRotativa01":
      return ["MoinhoMarteloM1", "MoinhoMarteloM2"];
    case "TransportadorCorreia02":
      return ["ValvulaRotativa01"];
    case "CaliaVibratoria":
      return ["TransportadorCorreia02"];
    case "TransportadorCorreia03":
    case "TransportadorCorreia04":
      return ["CaliaVibratoria"];
    default:
      return [];
  }
};

function downstreamOf(node: UnitKey): UnitKey[] {
  const result: UnitKey[] = [];
  const q: UnitKey[] = [node];
  const seen = new Set<UnitKey>();
  while (q.length) {
    const cur = q.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const ds = immediateDownstream(cur);
    for (const d of ds) {
      result.push(d);
      q.push(d);
    }
  }
  return result;
}

const isOnMode = (m: Mode) => m === MODE.MANUAL || m === MODE.AUTO;

const FINAL_LEFT: UnitKey = "TransportadorCorreia03";
const FINAL_RIGHT: UnitKey = "TransportadorCorreia04";

function topmostOnSeeds(s: StateRecord): UnitKey[] {
  const seeds: UnitKey[] = [];
  for (const k of ORDER) {
    if (!isOnMode(s[k])) continue;
    if (!upstreamOf(k).some((u) => isOnMode(s[u]))) seeds.push(k);
  }
  return seeds;
}

/* ======================= Ações e Grupo ======================= */

function createActions(
  state: StateRecord,
  setState: React.Dispatch<React.SetStateAction<StateRecord>>,
  timers: TimersRecord,
  setTimers: React.Dispatch<React.SetStateAction<TimersRecord>>,
  groupMode: GroupMode,
  setGroupMode: React.Dispatch<React.SetStateAction<GroupMode>>,
  setShutdownRun: React.Dispatch<React.SetStateAction<boolean>>,
  setStartupRun: React.Dispatch<React.SetStateAction<boolean>>
): Actions {
  const hasActiveTimers = () => Object.keys(timers).length > 0;
  const isDefect = (k: UnitKey) => state[k] === MODE.DEFECT;

  const addTimers = (keys: UnitKey[]) =>
    setTimers((t) => {
      const next: TimersRecord = { ...t };
      keys.forEach((k) => (next[k] = TIMER_SECONDS));
      return next;
    });

  const clearTimer = (key: UnitKey) =>
    setTimers((t) => {
      const n = { ...t };
      delete n[key];
      return n;
    });

  const clearTimersFor = (keys: UnitKey[]) =>
    setTimers((t) => {
      const n = { ...t };
      keys.forEach((k) => delete n[k]);
      return n;
    });

    const setGroupModeSafe = (nextMode: GroupMode) => {
      if (hasActiveTimers()) return;
      if (nextMode === GROUP_MODE.MANU) {
        setStartupRun(false);
        setShutdownRun(false);
        setTimers({});
      }
      setGroupMode(nextMode);
      if (nextMode === GROUP_MODE.AUTO) {
        setState((s) => {
          const n: Partial<StateRecord> = {};
          ORDER.forEach((k) => {
            if (s[k] === MODE.MANUAL) n[k] = MODE.AUTO;
          });
          return { ...s, ...n };
        });
      }
    };

  const groupPowerOn = () => {
    if (groupMode !== GROUP_MODE.AUTO) return;
    if (hasActiveTimers()) return;

    setShutdownRun(false);
    setStartupRun(true);
    setTimers({});

    const toTimer = new Set<UnitKey>();

    [FINAL_LEFT, FINAL_RIGHT].forEach((f) => {
      if (state[f] === MODE.OFF) {
        setState((s) => ({ ...s, [f]: MODE.AUTO }));
        toTimer.add(f);
      }
    });

    ORDER.forEach((k) => {
      if (state[k] === MODE.OFF) {
        const ds = immediateDownstream(k);
        if (ds.some((d) => state[d] === MODE.AUTO || state[d] === MODE.MANUAL)) {
          toTimer.add(k);
        }
      }
    });

    ORDER.forEach((k) => {
      if (
        state[k] === MODE.AUTO &&
        immediateDownstream(k).every(
          (d) => state[d] === MODE.MANUAL || state[d] === MODE.DEFECT
        )
      ) {
        toTimer.add(k);
      }
    });

    if (toTimer.size) addTimers(Array.from(toTimer));
  };

  const groupPowerOff = () => {
    if (groupMode !== GROUP_MODE.AUTO) return;
    if (hasActiveTimers()) return;
    const seeds = topmostOnSeeds(state);
    if (!seeds.length) return;
    setStartupRun(false);
    setShutdownRun(true);
    addTimers(seeds);
  };

  const clickManualOnly = (key: UnitKey) => {
    if (isDefect(key)) return;

    if (key === "MoinhoMarteloM1" || key === "MoinhoMarteloM2") {
      const self = key;
      const other: UnitKey = key === "MoinhoMarteloM1" ? "MoinhoMarteloM2" : "MoinhoMarteloM1";
      setState((s) => {
        const nextSelf = s[self] === MODE.MANUAL ? MODE.OFF : MODE.MANUAL;
        const next: StateRecord = { ...s, [self]: nextSelf, [other]: nextSelf };
        if (nextSelf === MODE.OFF) {
          for (const up of upstreamOf(self)) if (next[up] === MODE.AUTO) next[up] = MODE.OFF;
          for (const up of upstreamOf(other)) if (next[up] === MODE.AUTO) next[up] = MODE.OFF;
        }
        return next;
      });
      clearTimer(key);
      clearTimer(other);
      clearTimersFor([...upstreamOf(key), ...upstreamOf(other)]);
      return;
    }

    setState((s) => {
      const isTurningOff = s[key] === MODE.MANUAL;
      const next: StateRecord = { ...s, [key]: isTurningOff ? MODE.OFF : MODE.MANUAL };
      if (isTurningOff) {
        for (const up of upstreamOf(key)) if (next[up] === MODE.AUTO) next[up] = MODE.OFF;
      }
      return next;
    });
    clearTimer(key);
    clearTimersFor(upstreamOf(key));
  };

  const clickButton = (key: UnitKey) => {
    if (groupMode === GROUP_MODE.AUTO) return;
    return clickManualOnly(key);
  };

  const toggleDefect = (key: UnitKey) => {
    if (groupMode === GROUP_MODE.AUTO) return;
    const willBeDefect = state[key] !== MODE.DEFECT;
    setState((s) => {
      const next: StateRecord = { ...s, [key]: willBeDefect ? MODE.DEFECT : MODE.OFF };
      if (willBeDefect) {
        for (const up of upstreamOf(key)) if (next[up] !== MODE.DEFECT) next[up] = MODE.OFF;
      }
      return next;
    });
    if (willBeDefect) {
      clearTimersFor(upstreamOf(key));
    }
  };

  return { clickButton, toggleDefect, setGroupMode: setGroupModeSafe, groupPowerOn, groupPowerOff };
}

/* ======================= Intertravamentos & Cascatas ======================= */

function useInterlocks(
  state: StateRecord,
  setState: React.Dispatch<React.SetStateAction<StateRecord>>,
  timers: TimersRecord,
  setTimers: React.Dispatch<React.SetStateAction<TimersRecord>>,
  groupMode: GroupMode,
  shutdownRun: boolean,
  setShutdownRun: React.Dispatch<React.SetStateAction<boolean>>,
  startupRun: boolean,
  setStartupRun: React.Dispatch<React.SetStateAction<boolean>>
) {
  const interlocksEnabled = groupMode === GROUP_MODE.AUTO;

  const visitedDownRef = useRef<Set<UnitKey>>(new Set());
  const shutdownWasOnRef = useRef(false);
  useEffect(() => {
    if (!shutdownWasOnRef.current && shutdownRun) visitedDownRef.current = new Set();
    shutdownWasOnRef.current = shutdownRun;
  }, [shutdownRun]);

  useEffect(() => {
    if (!interlocksEnabled) return;
    const a = state.MoinhoMarteloM1;
    const b = state.MoinhoMarteloM2;
    if (a === MODE.DEFECT || b === MODE.DEFECT || a === b) return;
    const next: Mode =
      a === MODE.MANUAL || b === MODE.MANUAL
        ? MODE.MANUAL
        : a === MODE.AUTO || b === MODE.AUTO
        ? MODE.AUTO
        : MODE.OFF;
    setState((s) => ({ ...s, MoinhoMarteloM1: next, MoinhoMarteloM2: next }));
  }, [interlocksEnabled, state.MoinhoMarteloM1, state.MoinhoMarteloM2, setState]);

  useEffect(() => {
    if (!Object.keys(timers).length) return;

    const id = setInterval(() => {
      setTimers((prev) => {
        const nextBase: TimersRecord = {};
        const expired: UnitKey[] = [];
        for (const [k, v] of Object.entries(prev) as [UnitKey, number][]) {
          const nv = v - 1;
          if (nv <= 0) expired.push(k);
          else nextBase[k] = nv;
        }

        if (shutdownRun) {
          if (expired.length) {
            setState((s) => {
              const u = { ...s };
              for (const k of expired) {
                if (u[k] === MODE.MANUAL || u[k] === MODE.AUTO) u[k] = MODE.OFF;
              }
              return u;
            });
            const v = new Set(visitedDownRef.current);
            expired.forEach((k) => v.add(k));
            visitedDownRef.current = v;
          }

          const next: TimersRecord = { ...nextBase };

          if (expired.length) {
            for (const k of expired) {
              for (const d of immediateDownstream(k)) {
                if (next[d] == null) next[d] = TIMER_SECONDS;
              }
            }
          }

          if (Object.keys(next).length === 0) {
            const anyOn = ORDER.some((k) => isOnMode(state[k]));
            if (!anyOn) {
              setShutdownRun(false);
              visitedDownRef.current = new Set();
            }
          }

          return next;
        }
        
        if (startupRun) {
          const next: TimersRecord = { ...nextBase };
          const draft: StateRecord = { ...state };
          const promotedThisTick = new Set<UnitKey>();
          const interlockedThisTick = new Set<UnitKey>();

          const expiredByDepth = [...expired].sort((a, b) => idxOf(b) - idxOf(a));
          const schedule = (k: UnitKey) => {
            if (next[k] == null && timers[k] == null) {
              next[k] = TIMER_SECONDS;
            }
          };

          for (const k of expiredByDepth) {
            const cur = state[k];

            if (cur === MODE.OFF) {
              if (draft[k] === MODE.OFF) {
                draft[k] = MODE.AUTO;
                interlockedThisTick.add(k);
                if (timers[k] == null) schedule(k);
              }
              continue;
            }

            if (cur === MODE.AUTO) {
              const ds = immediateDownstream(k);
              const ready = ds.every((d) => state[d] === MODE.MANUAL || state[d] === MODE.DEFECT);

              if (ready) {
                draft[k] = MODE.MANUAL;
                promotedThisTick.add(k);
              } else {
                schedule(k);
              }
            }
          }

          for (const k of promotedThisTick) {
            for (const up of immediateUpstream(k)) {
              const hasDefectBelow = downstreamOf(up).some((d) => draft[d] === MODE.DEFECT);

              if (draft[up] === MODE.OFF && !hasDefectBelow) {
                draft[up] = MODE.AUTO;
                if (timers[up] == null) schedule(up);
              } else if (draft[up] === MODE.AUTO) {
                if (timers[up] == null) schedule(up);
              }
            }
          }

          for (const k of interlockedThisTick) {
            for (const up of immediateUpstream(k)) {
              const hasDefectBelow = downstreamOf(up).some((d) => draft[d] === MODE.DEFECT);

              if (!hasDefectBelow) {
                if (draft[up] === MODE.OFF) {
                  if (timers[up] == null) schedule(up);
                } else if (draft[up] === MODE.AUTO) {
                  if (timers[up] == null) schedule(up);
                }
              }
            }
          }

          setState(draft);
          if (Object.keys(next).length === 0) setStartupRun(false);
          return next;
        }

        return nextBase;
      });
    }, 1000);

    return () => clearInterval(id);
  }, [timers, setTimers, setState, shutdownRun, startupRun, state, setShutdownRun, setStartupRun]);

  useEffect(() => {
    if (shutdownRun || startupRun) return;
    setTimers((t) => {
      const n = { ...t };
      let changed = false;
      ORDER.forEach((k) => {
        if ((state[k] === MODE.OFF || state[k] === MODE.DEFECT) && n[k] != null) {
          delete n[k];
          changed = true;
        }
      });
      return changed ? n : t;
    });
  }, [state, setTimers, shutdownRun, startupRun]);

  const prevRef = useRef<StateRecord>(state);
  useEffect(() => {
    if (!shutdownRun) {
      prevRef.current = state;
      return;
    }
    const prev = prevRef.current;
    ORDER.forEach((k) => {
      const wasOn = prev[k] === MODE.MANUAL || prev[k] === MODE.AUTO;
      const isOffNow = state[k] === MODE.OFF;
      if (wasOn && isOffNow) {
        setTimers((t) => {
          const add = { ...t };
          for (const d of immediateDownstream(k)) if (!add[d]) add[d] = TIMER_SECONDS;
          return add;
        });
      }
    });
    prevRef.current = state;
  }, [shutdownRun, state, setTimers]);
}

/* ======================= UI Helpers ======================= */

function StatusDot({ mode }: { mode: Mode }) {
  const cls =
    mode === MODE.MANUAL
      ? "bg-green-500 border-green-600"
      : mode === MODE.AUTO
      ? "bg-yellow-400 border-yellow-500"
      : mode === MODE.DEFECT
      ? "bg-red-500 border-red-600"
      : "bg-white border-gray-300";
  return <span className={["inline-block size-3 rounded-full border animate-pulse", cls].join(" ")} />;
}

function modeToText(mode: Mode) {
  return mode === MODE.MANUAL ? "Ligado" : mode === MODE.AUTO ? "Interlock" : mode === MODE.DEFECT ? "Defeito" : "Desligado";
}

const ITEM_COMMON = [
  "flex items-center justify-between w-full text-left",
  "rounded-2xl px-4 py-3 border",
  "min-h-[56px]",
  "shadow-sm",
  "transition select-none",
];

function buttonClasses(mode: Mode, disabled: boolean) {
  const base = [...ITEM_COMMON, disabled ? "cursor-not-allowed opacity-50" : "hover:shadow-md"];
  const byMode =
    mode === MODE.MANUAL
      ? "bg-green-50 border-green-200"
      : mode === MODE.AUTO
      ? "bg-yellow-50 border-yellow-200"
      : mode === MODE.DEFECT
      ? "bg-red-50 border-red-200"
      : "bg-white border-gray-200";
  return [...base, byMode].join(" ");
}

function badgeClasses(mode: Mode, disabled: boolean) {
  const base = [...ITEM_COMMON, disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:shadow-md"];
  const border =
    mode === MODE.MANUAL
      ? "border-green-500"
      : mode === MODE.AUTO
      ? "border-yellow-500"
      : mode === MODE.DEFECT
      ? "border-red-500"
      : "border-slate-300";
  const bg =
    mode === MODE.MANUAL
      ? "bg-green-50"
      : mode === MODE.AUTO
      ? "bg-yellow-50"
      : mode === MODE.DEFECT
      ? "bg-red-50"
      : "bg-white";
  return [...base, border, bg].join(" ");
}

function Countdown({ unitKey }: { unitKey: UnitKey }) {
  const { timers } = useSystem();
  const remaining = timers[unitKey];
  if (remaining == null) return null;

  return (
    <span
      className="text-[10px] ml-2 px-1.5 py-0.5 rounded bg-slate-100 border text-slate-600"
      title="Mudança em"
    >
      {remaining}s
    </span>
  );
}

/* ======================= UI: Controles e Processos ======================= */

function ToggleButton({ unitKey }: { unitKey: UnitKey }) {
  const { state, actions, groupMode } = useSystem();
  const mode = state[unitKey];
  const disabled = mode === MODE.DEFECT || groupMode === GROUP_MODE.AUTO;

  return (
    <button
      onClick={() => actions.clickButton(unitKey)}
      className={buttonClasses(mode, disabled)}
      aria-pressed={mode === MODE.MANUAL || mode === MODE.AUTO}
      aria-disabled={disabled}
      disabled={disabled}
      title={disabled ? "Desabilitado no modo AUTO" : undefined}
    >
      <div className="flex items-center gap-3">
        <StatusDot mode={mode} />
        <span className="font-medium text-black">{LABELS[unitKey]}</span>
      </div>
      <div className="flex items-center">
        <span className="text-xs px-2 py-1 rounded-full border bg-white">{modeToText(mode)}</span>
        <Countdown unitKey={unitKey} />
      </div>
    </button>
  );
}

function ProcessBadge({ unitKey }: { unitKey: UnitKey }) {
  const { state, actions, groupMode } = useSystem();
  const mode = state[unitKey];
  const disabled = groupMode === GROUP_MODE.AUTO;

  return (
    <div
      role="button"
      onClick={() => !disabled && actions.toggleDefect(unitKey)}
      className={badgeClasses(mode, disabled)}
      title={
        disabled
          ? "Desabilitado no modo AUTO"
          : mode === MODE.DEFECT
          ? "Clique para limpar defeito"
          : "Clique para marcar defeito"
      }
    >
      <div className="flex items-center gap-3">
        <StatusDot mode={mode} />
        <span className="font-medium text-black">{LABELS[unitKey]}</span>
      </div>
      <div className="flex items-center">
        <span className="text-xs px-2 py-1 rounded-full border bg-white">{modeToText(mode)}</span>
        <Countdown unitKey={unitKey} />
      </div>
    </div>
  );
}

/* ======================= UI: Listas ======================= */

function ControlsList() {
  return (
    <div className="space-y-3">
      <ToggleButton unitKey="TransportadorCorreia01" />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ToggleButton unitKey="MoinhoMarteloM1" />
        <ToggleButton unitKey="MoinhoMarteloM2" />
      </div>

      <ToggleButton unitKey="ValvulaRotativa01" />
      <ToggleButton unitKey="TransportadorCorreia02" />
      <ToggleButton unitKey="CaliaVibratoria" />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ToggleButton unitKey="TransportadorCorreia03" />
        <ToggleButton unitKey="TransportadorCorreia04" />
      </div>
    </div>
  );
}

function VisualList() {
  return (
    <div className="space-y-3">
      <ProcessBadge unitKey="TransportadorCorreia01" />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ProcessBadge unitKey="MoinhoMarteloM1" />
        <ProcessBadge unitKey="MoinhoMarteloM2" />
      </div>

      <ProcessBadge unitKey="ValvulaRotativa01" />
      <ProcessBadge unitKey="TransportadorCorreia02" />
      <ProcessBadge unitKey="CaliaVibratoria" />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ProcessBadge unitKey="TransportadorCorreia03" />
        <ProcessBadge unitKey="TransportadorCorreia04" />
      </div>
    </div>
  );
}

/* ======================= UI: Grupo (AUTO / MANU) + On/Off ======================= */

function GroupSelector() {
  const { groupMode, actions, timers } = useSystem();
  const isAuto = groupMode === GROUP_MODE.AUTO;
  const hasActiveTimers = Object.keys(timers).length > 0;

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
      <h3 className="text-sm font-semibold mb-2 text-black">Grupo</h3>
      <div className="flex gap-2">
        <button
          type="button"
          aria-pressed={isAuto}
          onClick={() => actions.setGroupMode(GROUP_MODE.AUTO)}
          disabled={hasActiveTimers}
          className={[
            "px-3 py-1.5 rounded-xl border text-sm transition",
            hasActiveTimers
              ? "bg-white text-slate-400 border-slate-200 cursor-not-allowed"
              : isAuto
              ? "bg-slate-900 text-white border-slate-900 shadow-sm"
              : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50",
          ].join(" ")}
        >
          Automático
        </button>
        <button
          type="button"
          aria-pressed={!isAuto}
          onClick={() => actions.setGroupMode(GROUP_MODE.MANU)}
          disabled={hasActiveTimers}
          className={[
            "px-3 py-1.5 rounded-xl border text-sm transition",
            hasActiveTimers
              ? "bg-white text-slate-400 border-slate-200 cursor-not-allowed"
              : !isAuto
              ? "bg-slate-900 text-white border-slate-900 shadow-sm"
              : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50",
          ].join(" ")}
        >
          Manual
        </button>
      </div>
      <p className="text-xs text-slate-500 mt-2">Espere os contadores terminarem para alterar.</p>
    </div>
  );
}

function GroupPowerBox() {
  const { actions, groupMode, timers } = useSystem();
  const disabled = groupMode !== GROUP_MODE.AUTO || Object.keys(timers).length > 0;

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
      <h3 className="text-sm font-semibold mb-2 text-black">On/Off</h3>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={actions.groupPowerOn}
          disabled={disabled}
          className={[
            "px-3 py-1.5 rounded-xl border text-sm transition",
            disabled
              ? "bg-white text-slate-400 border-slate-200 cursor-not-allowed"
              : "bg-green-600 text-white border-green-700 hover:bg-green-700",
          ].join(" ")}
        >
          Ligar fluxo
        </button>
        <button
          type="button"
          onClick={actions.groupPowerOff}
          disabled={disabled}
          className={[
            "px-3 py-1.5 rounded-xl border text-sm transition",
            disabled
              ? "bg-white text-slate-400 border-slate-200 cursor-not-allowed"
              : "bg-red-600 text-white border-red-700 hover:bg-red-700",
          ].join(" ")}
        >
          Desligar fluxo
        </button>
      </div>

      {groupMode !== GROUP_MODE.AUTO && (
        <p className="text-xs text-slate-500 mt-2">
          Disponível apenas quando o Grupo estiver em <strong>Automático</strong>.
        </p>
      )}
    </div>
  );
}

/* ======================= Painel Principal ======================= */

export default function IndustrialFlowPanel() {
  return (
    <SystemProvider>
      <div className="min-h-screen w-full bg-gradient-to-b from-slate-50 to-slate-100 p-6">
        <main className="mx-auto max-w-5xl">
          <header className="mb-6">
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-black">
              Fluxo Industrial (V1.6)
            </h1>
            <p className="text-slate-700 mt-1">
              Simulação de um fluxo industrial usando react com typescript.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
              <GroupSelector />
              <GroupPowerBox />
            </div>
          </header>

          <section className="grid grid-cols-1 md:grid-cols-2 gap-5 items-start">
            <Card title="Equipamentos">
              <ControlsList />
            </Card>

            <Card title="Alarmes">
              <VisualList />
            </Card>
          </section>

          <p className="text-slate-700 mt-6">
            No modo <strong>Automático</strong>, os controles individuais ficam desabilitados. Além disso, equipamentos <strong>Ligados</strong> passam a <strong>Interlock</strong>. Ao marcar <strong>Defeito</strong>, todos em <strong>Interlock</strong> acima desligam.
          </p>
        </main>
      </div>
    </SystemProvider>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
      <h2 className="text-lg font-semibold mb-3 text-black">{title}</h2>
      {children}
    </div>
  );
}