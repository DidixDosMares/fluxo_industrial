"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  ReactNode,
} from "react";

/* ======================= Tipos e Constantes ======================= */

type Mode = "off" | "manual" | "defect";
type GroupMode = "auto" | "manu";

const MODE = { OFF: "off", MANUAL: "manual", DEFECT: "defect" } as const;
const GROUP_MODE = { AUTO: "auto", MANU: "manu" } as const;
const TIMER_SECONDS = 2;

const ORDER = [
  "TransportadorCorreia01",
  "MoinhoMarteloM1",
  "MoinhoMarteloM2",
  "ValvulaRotativa01",
  "TransportadorCorreia02",
  "PeneiraVibratoria01",
  "TransportadorCorreia03",
  "TransportadorCorreia04",
] as const;

type UnitKey = (typeof ORDER)[number];
type StateRecord = Record<UnitKey, Mode>;
type TimersRecord = Partial<Record<UnitKey, number>>;
type PulsesRecord = Record<UnitKey, boolean>;
type ManualRecord = Record<UnitKey, boolean>;

const LABELS: Record<UnitKey, string> = {
  TransportadorCorreia01: "TC01",
  MoinhoMarteloM1: "MM01M1",
  MoinhoMarteloM2: "MM01M2",
  ValvulaRotativa01: "VR01",
  TransportadorCorreia02: "TC02",
  PeneiraVibratoria01: "CV01",
  TransportadorCorreia03: "TC03",
  TransportadorCorreia04: "TC04",
};

/* ======================= Contexto ======================= */

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
  pulses: PulsesRecord;
}

const SystemContext = createContext<SystemContextValue | null>(null);

const makeInitialState = (): StateRecord =>
  Object.fromEntries(ORDER.map((k) => [k, MODE.OFF])) as StateRecord;
const makeInitialPulses = (): PulsesRecord =>
  Object.fromEntries(ORDER.map((k) => [k, false])) as PulsesRecord;
const makeInitialManual = (): ManualRecord =>
  Object.fromEntries(ORDER.map((k) => [k, false])) as ManualRecord;

/* ======================= Persistência hydration-safe ======================= */

const isGroupMode = (v: unknown): v is GroupMode => v === "auto" || v === "manu";
const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";

const isStateRecord = (v: unknown): v is StateRecord => {
  if (!v || typeof v !== "object") return false;
  const rec = v as Record<string, unknown>;
  return ORDER.every((k) => rec[k] === MODE.OFF || rec[k] === MODE.MANUAL || rec[k] === MODE.DEFECT);
};

const isPulses = (v: unknown): v is PulsesRecord => {
  if (!v || typeof v !== "object") return false;
  const rec = v as Record<string, unknown>;
  return ORDER.every((k) => typeof rec[k] === "boolean");
};

const isManual = (v: unknown): v is ManualRecord => {
  if (!v || typeof v !== "object") return false;
  const rec = v as Record<string, unknown>;
  return ORDER.every((k) => typeof rec[k] === "boolean");
};

function useSavedState<T>(key: string, initial: T, validate?: (v: unknown) => v is T) {
  const [hydrated, setHydrated] = useState(false);
  const [val, setVal] = useState<T>(initial);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) {
        const parsed: unknown = JSON.parse(raw);
        if (!validate || validate(parsed)) setVal(parsed as T);
        else localStorage.removeItem(key);
      }
    } catch {}
    setHydrated(true);
  }, [key, validate]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {}
  }, [key, val, hydrated]);

  return [val, setVal, hydrated] as const;
}

function useEphemeralState<T>(initial: T) {
  const [val, setVal] = useState<T>(initial);
  return [val, setVal] as const;
}

/* ======================= Provider ======================= */

function SystemProvider({ children }: { children: ReactNode }) {
  const [state, setState, stateHydrated] = useSavedState<StateRecord>(
    "flow_state",
    makeInitialState(),
    isStateRecord
  );
  const [timers, setTimers] = useEphemeralState<TimersRecord>({});
  const [groupMode, setGroupMode, groupModeHydrated] = useSavedState<GroupMode>(
    "flow_group_mode",
    GROUP_MODE.AUTO,
    isGroupMode
  );
  const [shutdownRun, setShutdownRun, shutdownHydrated] = useSavedState<boolean>(
    "flow_shutdown_active",
    false,
    isBoolean
  );
  const [startupRun, setStartupRun, startupHydrated] = useSavedState<boolean>(
    "flow_startup_active",
    false,
    isBoolean
  );
  const [pulses, setPulses, pulsesHydrated] = useSavedState<PulsesRecord>(
    "flow_pulses",
    makeInitialPulses(),
    isPulses
  );
  const [manualOn, setManualOn, manualHydrated] = useSavedState<ManualRecord>(
    "flow_manual_on",
    makeInitialManual(),
    isManual
  );

  const hydrated =
    stateHydrated &&
    groupModeHydrated &&
    shutdownHydrated &&
    startupHydrated &&
    pulsesHydrated &&
    manualHydrated;

  useEffect(() => {
    if (!hydrated) return;
    const m1 = state.MoinhoMarteloM1;
    const m2 = state.MoinhoMarteloM2;
    if (m1 !== MODE.DEFECT && m2 !== MODE.DEFECT) {
      const bothOn = m1 === MODE.MANUAL && m2 === MODE.MANUAL;
      const bothOff = m1 === MODE.OFF && m2 === MODE.OFF;
      if (!bothOn && !bothOff) {
        setState((s) => ({ ...s, MoinhoMarteloM1: MODE.OFF, MoinhoMarteloM2: MODE.OFF }));
        setManualOn((m) => ({ ...m, MoinhoMarteloM1: false, MoinhoMarteloM2: false }));
        setPulses((p) => ({ ...p, MoinhoMarteloM1: false, MoinhoMarteloM2: false }));
        setTimers((t) => {
          const nt = { ...t };
          delete nt.MoinhoMarteloM1;
          delete nt.MoinhoMarteloM2;
          return nt;
        });
      }
    }
  }, [
    hydrated,
    setState,
    setManualOn,
    setPulses,
    setTimers,
    state.MoinhoMarteloM1,
    state.MoinhoMarteloM2,
  ]);

  useInterlocksAndCascades(
    state,
    setState,
    timers,
    setTimers,
    groupMode,
    shutdownRun,
    setShutdownRun,
    startupRun,
    setStartupRun,
    setPulses,
    manualOn,
    setManualOn
  );

  // NÃO dar return antes dos hooks; crie os memos sempre
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
        setStartupRun,
        pulses,
        setPulses,
        manualOn,
        setManualOn
      ),
    [
      state,
      timers,
      groupMode,
      setShutdownRun,
      setStartupRun,
      setGroupMode,
      setState,
      setTimers,
      pulses,
      setPulses,
      manualOn,
      setManualOn,
    ]
  );

  const value = useMemo<SystemContextValue>(
    () => ({ state, actions, timers, groupMode, startupRun, shutdownRun, pulses }),
    [state, actions, timers, groupMode, startupRun, shutdownRun, pulses]
  );

  return (
    <SystemContext.Provider value={value}>
      {hydrated ? children : null}
    </SystemContext.Provider>
  );
}

function useSystem(): SystemContextValue {
  const ctx = useContext(SystemContext);
  if (!ctx) throw new Error("useSystem deve ser usado dentro de <SystemProvider>");
  return ctx;
}

/* ======================= Topologia ======================= */

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
      return ["PeneiraVibratoria01"];
    case "PeneiraVibratoria01":
      return ["TransportadorCorreia03", "TransportadorCorreia04"];
    default:
      return [];
  }
};

const isOnMode = (m: Mode) => m === MODE.MANUAL;
const isMill = (k: UnitKey) => k === "MoinhoMarteloM1" || k === "MoinhoMarteloM2";
const siblingMill = (k: UnitKey): UnitKey => (k === "MoinhoMarteloM1" ? "MoinhoMarteloM2" : "MoinhoMarteloM1");

function anyDefectDownstream(s: StateRecord, key: UnitKey): boolean {
  const visited = new Set<UnitKey>();
  const queue = [...immediateDownstream(key)];
  while (queue.length) {
    const cur = queue.shift() as UnitKey;
    if (visited.has(cur)) continue;
    visited.add(cur);
    if (s[cur] === MODE.DEFECT) return true;
    queue.push(...immediateDownstream(cur));
  }
  return false;
}

function withMillPair(keys: UnitKey[]): UnitKey[] {
  const set = new Set<UnitKey>(keys);
  keys.forEach((k) => {
    if (isMill(k)) set.add(siblingMill(k));
  });
  return Array.from(set);
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
  setStartupRun: React.Dispatch<React.SetStateAction<boolean>>,
  pulses: PulsesRecord,
  setPulses: React.Dispatch<React.SetStateAction<PulsesRecord>>,
  manualOn: ManualRecord,
  setManualOn: React.Dispatch<React.SetStateAction<ManualRecord>>
): Actions {
  const hasActiveTimers = () => Object.keys(timers).length > 0;
  const isDefect = (k: UnitKey) => state[k] === MODE.DEFECT;

  const addTimers = (keys: UnitKey[]) =>
    setTimers((t) => {
      const next: TimersRecord = { ...t };
      withMillPair(keys).forEach((k) => (next[k] = TIMER_SECONDS));
      return next;
    });

  const clearTimersFor = (keys: UnitKey[]) =>
    setTimers((t) => {
      const n = { ...t };
      withMillPair(keys).forEach((k) => delete n[k]);
      return n;
    });

  const clearAllPulses = () => setPulses(makeInitialPulses());

  const isReadyToTurnOn = (s: StateRecord, key: UnitKey) => {
    if (s[key] !== MODE.OFF) return false;
    if (isMill(key)) {
      const other = siblingMill(key);
      if (s[other] === MODE.DEFECT) return false;
    }
    if (anyDefectDownstream(s, key)) return false;
    return immediateDownstream(key).every((d) => s[d] === MODE.MANUAL || s[d] === MODE.DEFECT);
  };

  const setGroupModeSafe = (nextMode: GroupMode) => {
    if (hasActiveTimers()) return;

    if (nextMode === GROUP_MODE.MANU) {
      setStartupRun(false);
      setShutdownRun(false);
      setTimers({});
      setGroupMode(nextMode);
      return;
    }

    setShutdownRun(false);
    setGroupMode(nextMode);
    clearAllPulses();

    const draft: StateRecord = { ...state };
    const turnedOff: UnitKey[] = [];

    for (const k of ORDER) {
      if (draft[k] === MODE.MANUAL && !manualOn[k]) {
        const siblingBlocked = isMill(k) && draft[siblingMill(k)] === MODE.DEFECT;
        const defectBelow = anyDefectDownstream(draft, k);
        if (siblingBlocked || defectBelow) {
          draft[k] = MODE.OFF;
          turnedOff.push(k);
        }
      }
    }

    const toSchedule: UnitKey[] = [];
    ORDER.forEach((k) => {
      if (isReadyToTurnOn(draft, k)) toSchedule.push(k);
    });

    setState(draft);
    if (turnedOff.length) {
      setManualOn((m) => {
        const nm = { ...m };
        turnedOff.forEach((k) => (nm[k] = false));
        return nm;
      });
    }

    const anyOn = ORDER.some((k) => draft[k] === MODE.MANUAL);
    setStartupRun(anyOn);

    if (anyOn && toSchedule.length) {
      setTimers(Object.fromEntries(withMillPair(toSchedule).map((k) => [k, TIMER_SECONDS])) as TimersRecord);
    } else {
      setTimers({});
    }
  };

  const groupPowerOn = () => {
    if (groupMode !== GROUP_MODE.AUTO) return;
    if (hasActiveTimers()) return;

    const anyOn = ORDER.some((k) => state[k] === MODE.MANUAL);
    if (!anyOn) return;

    setShutdownRun(false);
    setStartupRun(true);

    const toSchedule: UnitKey[] = [];
    ORDER.forEach((k) => {
      if (isReadyToTurnOn(state, k)) toSchedule.push(k);
    });

    if (toSchedule.length) {
      setTimers(Object.fromEntries(withMillPair(toSchedule).map((k) => [k, TIMER_SECONDS])) as TimersRecord);
    } else {
      setTimers({});
    }
  };

  const groupPowerOff = () => {
    if (groupMode !== GROUP_MODE.AUTO) return;
    if (hasActiveTimers()) return;

    const seeds: UnitKey[] = [];
    for (const k of ORDER) {
      if (state[k] !== MODE.MANUAL) continue;
      const ups = ORDER.slice(0, ORDER.indexOf(k)) as UnitKey[];
      const anyUpOn = ups.some((u) => state[u] === MODE.MANUAL);
      if (!anyUpOn) seeds.push(k);
    }

    if (!seeds.length) return;

    setStartupRun(false);
    setShutdownRun(true);
    addTimers(withMillPair(seeds));
  };

  const clickManualOnly = (key: UnitKey) => {
    if (isDefect(key)) return;

    if (isMill(key)) {
      const self = key;
      const other: UnitKey = siblingMill(key);
      if (isDefect(other)) return;
      setState((s) => {
        const nextSelf = s[self] === MODE.MANUAL ? MODE.OFF : MODE.MANUAL;
        const next: StateRecord = { ...s, [self]: nextSelf, [other]: nextSelf };
        return next;
      });
      setManualOn((m) => {
        const nextOn = !(state[key] === MODE.MANUAL);
        return { ...m, [self]: nextOn, [other]: nextOn };
      });
      setPulses((p) => {
        const nextOn = !(state[key] === MODE.MANUAL);
        return { ...p, [self]: nextOn, [other]: nextOn };
      });
      clearTimersFor([key, other, ...upstreamOf(key), ...upstreamOf(other)]);
      return;
    }

    setState((s) => {
      const nextOn = s[key] !== MODE.MANUAL;
      const next: StateRecord = { ...s, [key]: nextOn ? MODE.MANUAL : MODE.OFF };
      return next;
    });
    setManualOn((m) => ({ ...m, [key]: state[key] !== MODE.MANUAL }));
    setPulses((p) => ({ ...p, [key]: state[key] !== MODE.MANUAL }));
    clearTimersFor([key, ...upstreamOf(key)]);
  };

  const clickButton = (key: UnitKey) => {
    if (groupMode === GROUP_MODE.AUTO) return;
    return clickManualOnly(key);
  };

  const toggleDefect = (key: UnitKey) => {
    if (groupMode === GROUP_MODE.AUTO) return;
    const willBeDefect = state[key] !== MODE.DEFECT;
    const toTurnOff: UnitKey[] = [];

    setState((s) => {
      const next: StateRecord = { ...s, [key]: willBeDefect ? MODE.DEFECT : MODE.OFF };

      if (willBeDefect) {
        const ups =
          key === "TransportadorCorreia04"
            ? upstreamOf(key).filter((u) => u !== "TransportadorCorreia03")
            : upstreamOf(key);

        for (const up of ups) {
          if (next[up] !== MODE.DEFECT) {
            next[up] = MODE.OFF;
            toTurnOff.push(up);
          }
        }

        if (isMill(key)) {
          const other = siblingMill(key);
          if (next[other] === MODE.MANUAL) {
            next[other] = MODE.OFF;
            toTurnOff.push(other);
          }
        }
      }

      return next;
    });

    if (willBeDefect) {
      if (toTurnOff.length) {
        clearTimersFor(toTurnOff);
        setPulses((p) => {
          const np = { ...p };
          for (const u of [...toTurnOff, key]) np[u] = false;
          return np;
        });
        setManualOn((m) => {
          const nm = { ...m };
          for (const u of toTurnOff) nm[u] = false;
          return nm;
        });
      } else {
        setPulses((p) => ({ ...p, [key]: false }));
      }
    }
  };

  return { clickButton, toggleDefect, setGroupMode: setGroupModeSafe, groupPowerOn, groupPowerOff };
}

/* ======================= Cascatas ======================= */

function useInterlocksAndCascades(
  state: StateRecord,
  setState: React.Dispatch<React.SetStateAction<StateRecord>>,
  timers: TimersRecord,
  setTimers: React.Dispatch<React.SetStateAction<TimersRecord>>,
  groupMode: GroupMode,
  shutdownRun: boolean,
  setShutdownRun: React.Dispatch<React.SetStateAction<boolean>>,
  startupRun: boolean,
  setStartupRun: React.Dispatch<React.SetStateAction<boolean>>,
  setPulses: React.Dispatch<React.SetStateAction<PulsesRecord>>,
  manualOn: ManualRecord,
  setManualOn: React.Dispatch<React.SetStateAction<ManualRecord>>
) {
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
        const expiredAll = withMillPair(expired);

        if (shutdownRun) {
          const next: TimersRecord = { ...nextBase };

          if (expiredAll.length) {
            const draft: StateRecord = { ...state };
            for (const k of expiredAll) if (draft[k] === MODE.MANUAL) draft[k] = MODE.OFF;
            setState(draft);

            setPulses((p) => {
              const np = { ...p };
              for (const k of expiredAll) np[k] = false;
              return np;
            });
            setManualOn((m) => {
              const nm: ManualRecord = { ...m };
              for (const k of expiredAll) nm[k] = false;
              return nm;
            });

            for (const k of expiredAll) {
              for (const d of immediateDownstream(k)) {
                if (next[d] == null && prev[d] == null && state[d] === MODE.MANUAL) {
                  next[d] = TIMER_SECONDS;
                }
              }
            }
          }

          if (Object.keys(next).length === 0) {
            const anyOn = ORDER.some((k) => isOnMode(state[k]));
            if (!anyOn) setShutdownRun(false);
          }

          return next;
        }

        if (startupRun) {
          const next: TimersRecord = { ...nextBase };
          const draft: StateRecord = { ...state };
          const promoted = new Set<UnitKey>();

          for (const k of expiredAll) {
            if (draft[k] === MODE.OFF) {
              draft[k] = MODE.MANUAL;
              promoted.add(k);
            }
          }

          if (promoted.size) {
            setPulses((p) => {
              const np = { ...p };
              for (const k of promoted) np[k] = false;
              return np;
            });
            setManualOn((m) => {
              const nm: ManualRecord = { ...m };
              for (const k of promoted) nm[k] = false;
              return nm;
            });
          }

          const isReady = (s: StateRecord, key: UnitKey) =>
            s[key] === MODE.OFF &&
            (!isMill(key) || s[siblingMill(key)] !== MODE.DEFECT) &&
            !anyDefectDownstream(s, key) &&
            immediateDownstream(key).every((d) => s[d] === MODE.MANUAL || s[d] === MODE.DEFECT);

          for (const k of promoted) {
            for (const up of upstreamOf(k)) {
              if (isReady(draft, up) && next[up] == null && prev[up] == null) {
                next[up] = TIMER_SECONDS;
              }
            }
          }

          ORDER.forEach((k) => {
            if (isReady(draft, k) && next[k] == null && prev[k] == null) {
              next[k] = TIMER_SECONDS;
            }
          });

          setState(draft);
          if (Object.keys(next).length === 0) setStartupRun(false);
          return next;
        }

        return nextBase;
      });
    }, 1000);

    return () => clearInterval(id);
  }, [
    timers,
    setTimers,
    setState,
    shutdownRun,
    startupRun,
    state,
    setShutdownRun,
    setStartupRun,
    setPulses,
    setManualOn,
  ]);

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
}

/* ======================= UI ======================= */

function StatusDot({ mode, pulsing }: { mode: Mode; pulsing: boolean }) {
  if (mode === MODE.MANUAL) {
    if (pulsing) {
      return (
        <span className="relative flex size-3">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75"></span>
          <span className="relative inline-flex size-3 rounded-full bg-green-500"></span>
        </span>
      );
    }
    return <span className="inline-block size-3 rounded-full bg-green-500" />;
  }
  if (mode === MODE.DEFECT) {
    return <span className="inline-block size-3 rounded-full bg-red-500" />;
  }
  return <span className="inline-block size-3 rounded-full bg-slate-300" />;
}

function modeToText(mode: Mode) {
  return mode === MODE.MANUAL ? "Ligado" : mode === MODE.DEFECT ? "Defeito" : "Desligado";
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
      : mode === MODE.DEFECT
      ? "bg-red-50 border-red-200"
      : "bg-white border-gray-200";
  return [...base, byMode].join(" ");
}

function badgeClasses(mode: Mode, disabled: boolean) {
  const base = [...ITEM_COMMON, disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:shadow-md"];
  const border =
    mode === MODE.MANUAL ? "border-green-500" : mode === MODE.DEFECT ? "border-red-500" : "border-slate-300";
  const bg = mode === MODE.MANUAL ? "bg-green-50" : mode === MODE.DEFECT ? "bg-red-50" : "bg-white";
  return [...base, border, bg].join(" ");
}

function Countdown({ unitKey }: { unitKey: UnitKey }) {
  const { timers } = useSystem();
  const remaining = timers[unitKey];
  if (remaining == null) return null;
  return (
    <span className="text-[10px] ml-2 px-1.5 py-0.5 rounded bg-slate-100 border text-slate-600" title="Mudança em">
      {remaining}s
    </span>
  );
}

function ToggleButton({ unitKey }: { unitKey: UnitKey }) {
  const { state, actions, groupMode, pulses } = useSystem();
  const mode = state[unitKey];
  const disabled = mode === MODE.DEFECT || groupMode === GROUP_MODE.AUTO;
  const pulsing = groupMode === GROUP_MODE.AUTO ? false : !!pulses[unitKey] && mode === MODE.MANUAL;

  return (
    <button
      onClick={() => actions.clickButton(unitKey)}
      className={buttonClasses(mode, disabled)}
      aria-pressed={mode === MODE.MANUAL}
      aria-disabled={disabled}
      disabled={disabled}
      title={disabled ? "Desabilitado no modo AUTO" : undefined}
    >
      <div className="flex items-center gap-3">
        <StatusDot mode={mode} pulsing={pulsing} />
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
  const { state, actions, groupMode, pulses } = useSystem();
  const mode = state[unitKey];
  const disabled = groupMode === GROUP_MODE.AUTO;
  const pulsing = groupMode === GROUP_MODE.AUTO ? false : !!pulses[unitKey] && mode === MODE.MANUAL;

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
        <StatusDot mode={mode} pulsing={pulsing} />
        <span className="font-medium text-black">{LABELS[unitKey]}</span>
      </div>
      <div className="flex items-center">
        <span className="text-xs px-2 py-1 rounded-full border bg-white">{modeToText(mode)}</span>
        <Countdown unitKey={unitKey} />
      </div>
    </div>
  );
}

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
      <ToggleButton unitKey="PeneiraVibratoria01" />
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
      <ProcessBadge unitKey="PeneiraVibratoria01" />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ProcessBadge unitKey="TransportadorCorreia03" />
        <ProcessBadge unitKey="TransportadorCorreia04" />
      </div>
    </div>
  );
}

function GroupControlsBox() {
  const { groupMode, actions, timers } = useSystem();
  const isAuto = groupMode === GROUP_MODE.AUTO;
  const hasActiveTimers = Object.keys(timers).length > 0;
  const powerDisabled = !isAuto || hasActiveTimers;

  const commonBtn = "w-36 px-4 py-2 rounded-xl border text-sm transition text-center";

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 w-full max-w-[760px] mx-auto">
      <h3 className="font-semibold mb-4 text-black text-center">Grupo da moagem</h3>

      <div className="flex w-full items-center justify-evenly">
        <button
          type="button"
          aria-pressed={isAuto}
          onClick={() => actions.setGroupMode(GROUP_MODE.AUTO)}
          disabled={hasActiveTimers}
          className={[
            commonBtn,
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
            commonBtn,
            hasActiveTimers
              ? "bg-white text-slate-400 border-slate-200 cursor-not-allowed"
              : !isAuto
              ? "bg-slate-900 text-white border-slate-900 shadow-sm"
              : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50",
          ].join(" ")}
        >
          Manual
        </button>

        <button
          type="button"
          onClick={actions.groupPowerOn}
          disabled={powerDisabled}
          className={[
            commonBtn,
            powerDisabled
              ? "bg-white text-slate-400 border-slate-200 cursor-not-allowed"
              : "bg-green-600 text-white border-green-700 hover:bg-green-700",
          ].join(" ")}
        >
          Ligar fluxo
        </button>

        <button
          type="button"
          onClick={actions.groupPowerOff}
          disabled={powerDisabled}
          className={[
            commonBtn,
            powerDisabled
              ? "bg-white text-slate-400 border-slate-200 cursor-not-allowed"
              : "bg-red-600 text-white border-red-700 hover:bg-red-700",
          ].join(" ")}
        >
          Desligar fluxo
        </button>
      </div>

      <div className="text-xs text-slate-500 mt-3 flex items-center justify-between">
        <span>Só pode alterar o modo após finalizar os contadores.</span>
        <span>
          Botões disponíveis somente no modo <strong>Automático</strong>.
        </span>
      </div>
    </div>
  );
}

export default function IndustrialFlowPanel() {
  return (
    <SystemProvider>
      <div className="min-h-screen w-full bg-gradient-to-b from-slate-50 to-slate-100 p-6">
        <main className="mx-auto max-w-5xl">
          <header className="mb-6">
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-black">Fluxo da Moagem</h1>
            <p className="text-slate-700 mt-1">Simulação de um fluxo industrial usando React com TypeScript.</p>
            <div className="grid grid-cols-1 gap-3 mt-3">
              <GroupControlsBox />
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
            No modo <strong>Automático</strong>, os controles individuais ficam desabilitados. Ao marcar um{" "}
            <strong>Defeito</strong>, todos os equipamentos acima desligam para evitar danos.
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