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
  return Object.fromEntries(ORDER.map((k) => [k, MODE.OFF])) as StateRecord;
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

  useInterlocksAndCascades(
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
      return ["PeneiraVibratoria01"];
    case "PeneiraVibratoria01":
      return ["TransportadorCorreia03", "TransportadorCorreia04"];
    default:
      return [];
  }
};

const isOnMode = (m: Mode) => m === MODE.MANUAL;

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
  };

  const isReadyToTurnOn = (s: StateRecord, key: UnitKey) =>
    s[key] === MODE.OFF && immediateDownstream(key).every((d) => s[d] === MODE.MANUAL || s[d] === MODE.DEFECT);

  const groupPowerOn = () => {
    if (groupMode !== GROUP_MODE.AUTO) return;
    if (hasActiveTimers()) return;

    setShutdownRun(false);
    setStartupRun(true);

    const toSchedule: UnitKey[] = [];
    ORDER.forEach((k) => {
      if (isReadyToTurnOn(state, k)) toSchedule.push(k);
    });

    if (toSchedule.length) {
      setTimers(Object.fromEntries(toSchedule.map((k) => [k, TIMER_SECONDS])) as TimersRecord);
    } else {
      setStartupRun(false);
      setTimers({});
    }
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
        return next;
      });
      clearTimersFor([key, other, ...upstreamOf(key), ...upstreamOf(other)]);
      return;
    }

    setState((s) => {
      const next: StateRecord = { ...s, [key]: s[key] === MODE.MANUAL ? MODE.OFF : MODE.MANUAL };
      return next;
    });
    clearTimersFor([key, ...upstreamOf(key)]);
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
        const ups = upstreamOf(key);

        const filteredUps =
          key === "TransportadorCorreia04" && s["TransportadorCorreia03"] === MODE.MANUAL
            ? ups.filter((u) => u !== "TransportadorCorreia03")
            : ups;

        for (const up of filteredUps) {
          if (next[up] !== MODE.DEFECT) next[up] = MODE.OFF;
        }
      }

      return next;
    });

    if (willBeDefect) {
      const ups = upstreamOf(key);
      const filteredUps =
        key === "TransportadorCorreia04" && state["TransportadorCorreia03"] === MODE.MANUAL
          ? ups.filter((u) => u !== "TransportadorCorreia03")
          : ups;

      clearTimersFor(filteredUps);
    }
  };

  return { clickButton, toggleDefect, setGroupMode: setGroupModeSafe, groupPowerOn, groupPowerOff };
}

/* ======================= Cascatas (ligar/desligar) ======================= */

function useInterlocksAndCascades(
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
          const next: TimersRecord = { ...nextBase };

          if (expired.length) {
            const draft: StateRecord = { ...state };
            for (const k of expired) {
              if (draft[k] === MODE.MANUAL) draft[k] = MODE.OFF;
            }
            setState(draft);

            for (const k of expired) {
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

          for (const k of expired) {
            if (draft[k] === MODE.OFF) {
              draft[k] = MODE.MANUAL;
              promoted.add(k);
            }
          }

          const isReady = (s: StateRecord, key: UnitKey) =>
            s[key] === MODE.OFF &&
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
}

/* ======================= UI Helpers ======================= */

function StatusDot({ mode }: { mode: Mode }) {
  if (mode === MODE.MANUAL) {
    return (
      <span className="relative flex size-3">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75"></span>
        <span className="relative inline-flex size-3 rounded-full bg-green-500"></span>
      </span>
    );
  }
  if (mode === MODE.DEFECT) {
    return (
      <span className="relative flex size-3">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75"></span>
        <span className="relative inline-flex size-3 rounded-full bg-red-500"></span>
      </span>
    );
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
      aria-pressed={mode === MODE.MANUAL}
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

/* ======================= UI: Grupo + On/Off ======================= */

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

/* ======================= Painel Principal ======================= */

export default function IndustrialFlowPanel() {
  return (
    <SystemProvider>
      <div className="min-h-screen w-full bg-gradient-to-b from-slate-50 to-slate-100 p-6">
        <main className="mx-auto max-w-5xl">
          <header className="mb-6">
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-black">
              Fluxo da Moagem
            </h1>
            <p className="text-slate-700 mt-1">
              Simulação de um fluxo industrial usando React com TypeScript.
            </p>

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
            No modo <strong>Automático</strong>, os controles individuais ficam desabilitados.
            Ao marcar um <strong>Defeito</strong>, todos os equipamentos acima desligam para evitar danos.
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