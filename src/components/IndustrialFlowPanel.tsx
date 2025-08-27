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
const TIMER_SECONDS = 3;

const ORDER = [
  "esteiraMain",
  "moedorMotorA",
  "moedorMotorB",
  "canoUnderMotor",
  "esteiraUnderCano",
  "separador",
  "esteiraEsquerda",
  "esteiraDireita",
] as const;

type UnitKey = (typeof ORDER)[number];
type StateRecord = Record<UnitKey, Mode>;
type TimersRecord = Partial<Record<UnitKey, number>>;

const LABELS: Record<UnitKey, string> = {
  esteiraMain: "TC01",
  moedorMotorA: "MM01M1",
  moedorMotorB: "MM01M2",
  canoUnderMotor: "VR01",
  esteiraUnderCano: "TC02",
  separador: "CV01",
  esteiraEsquerda: "TC03",
  esteiraDireita: "TC04",
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

/** Estado persistido em localStorage */
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

// Mapeamento imediato para cima e para baixo
const immediateDownstream = (key: UnitKey): UnitKey[] => {
  switch (key) {
    case "esteiraMain":
      return ["moedorMotorA", "moedorMotorB"];
    case "moedorMotorA":
    case "moedorMotorB":
      return ["canoUnderMotor"];
    case "canoUnderMotor":
      return ["esteiraUnderCano"];
    case "esteiraUnderCano":
      return ["separador"];
    case "separador":
      return ["esteiraEsquerda", "esteiraDireita"];
    default:
      return [];
  }
};
const immediateUpstream = (key: UnitKey): UnitKey[] => {
  switch (key) {
    case "moedorMotorA":
    case "moedorMotorB":
      return ["esteiraMain"];
    case "canoUnderMotor":
      return ["moedorMotorA", "moedorMotorB"];
    case "esteiraUnderCano":
      return ["canoUnderMotor"];
    case "separador":
      return ["esteiraUnderCano"];
    case "esteiraEsquerda":
    case "esteiraDireita":
      return ["separador"];
    default:
      return [];
  }
};

// todos os descendentes (downstream) de um nó (busca em largura)
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

const FINAL_LEFT: UnitKey = "esteiraEsquerda";
const FINAL_RIGHT: UnitKey = "esteiraDireita";

/** Sementes de desligamento: primeiros nós ON de cada ramo (sem montante ON) */
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

  const bulk = (entries: Partial<StateRecord>) => setState((s) => ({ ...s, ...entries }));

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

  // Não permitir troca de modo enquanto houver timers rodando
  const setGroupModeSafe = (nextMode: GroupMode) => {
    if (hasActiveTimers()) return; // bloqueia alternância com contadores ativos
    setGroupMode(nextMode);
    if (nextMode === GROUP_MODE.AUTO) {
      // MANUAL -> AUTO: verdes -> amarelos, exceto TC03/TC04
      setState((s) => {
        const n: Partial<StateRecord> = {};
        ORDER.forEach((k) => {
          if (k === FINAL_LEFT || k === FINAL_RIGHT) return; // exceção
          if (s[k] === MODE.MANUAL) n[k] = MODE.AUTO;
        });
        return { ...s, ...n };
      });
    }
  };

  // Regras de startup respeitando defeitos: um nó só pode ligar via AUTO/cascata
  // se não houver nenhum defeito em sua cadeia downstream.
  const canAutoStart = (k: UnitKey) => {
    if (state[k] === MODE.DEFECT) return false;
    const ds = downstreamOf(k);
    return !ds.some((d) => state[d] === MODE.DEFECT);
  };

  // Ligar em cascata de baixo pra cima:
  // - finais (TC03/TC04) verdes (se não defeito)
  // - nós acima ficam AMARELO e recebem TIMER neles mesmos (contador no próprio nó)
  // - a cada 3s, o nó com timer vira VERDE e agenda o imediatamente acima
  const groupPowerOn = () => {
    if (groupMode !== GROUP_MODE.AUTO) return;
    if (hasActiveTimers()) return; // evita iniciar com contadores ativos

    setShutdownRun(false);
    setStartupRun(false);
    setTimers({});

    // finais verdes se não defeito
    const finalsOn: Partial<StateRecord> = {};
    if (state[FINAL_LEFT] !== MODE.DEFECT) finalsOn[FINAL_LEFT] = MODE.MANUAL;
    if (state[FINAL_RIGHT] !== MODE.DEFECT) finalsOn[FINAL_RIGHT] = MODE.MANUAL;

    // todos montantes amarelos (quando permitido) e timers no imediato acima dos finais
    const toAutoNow = new Set<UnitKey>();
    const toTimer: UnitKey[] = [];

    function seedAbove(finalKey: UnitKey) {
      for (const up of upstreamOf(finalKey)) {
        if (canAutoStart(up)) toAutoNow.add(up);
      }
      for (const u of immediateUpstream(finalKey)) {
        if (canAutoStart(u)) toTimer.push(u);
      }
    }

    seedAbove(FINAL_LEFT);
    seedAbove(FINAL_RIGHT);

    const autoObj: Partial<StateRecord> = {};
    toAutoNow.forEach((k) => {
      if (state[k] !== MODE.DEFECT) autoObj[k] = MODE.AUTO;
    });

    bulk({ ...autoObj, ...finalsOn });
    if (toTimer.length) addTimers(toTimer);
    setStartupRun(!!toTimer.length);
  };

  // Desligamento em cascata
  const groupPowerOff = () => {
    if (groupMode !== GROUP_MODE.AUTO) return;
    if (hasActiveTimers()) return;
    const seeds = topmostOnSeeds(state);
    if (!seeds.length) return;
    setStartupRun(false);
    setShutdownRun(true);
    addTimers(seeds);
  };

  /** Clique manual (permitido em MANU): moedores espelhados; demais alternam */
  const clickManualOnly = (key: UnitKey) => {
    if (isDefect(key)) return;

    if (key === "moedorMotorA" || key === "moedorMotorB") {
      const self = key;
      const other: UnitKey = key === "moedorMotorA" ? "moedorMotorB" : "moedorMotorA";
      setState((s) => {
        const nextSelf = s[self] === MODE.MANUAL ? MODE.OFF : MODE.MANUAL;
        return { ...s, [self]: nextSelf, [other]: nextSelf };
      });
      clearTimer(key);
      clearTimer(other);
      return;
    }

    setState((s) => {
      const next: Mode = s[key] === MODE.MANUAL ? MODE.OFF : MODE.MANUAL;
      return { ...s, [key]: next };
    });
    clearTimer(key);
  };

  const clickButton = (key: UnitKey) => {
    if (groupMode === GROUP_MODE.AUTO) return;
    return clickManualOnly(key);
  };

  // Ao marcar defeito, processos acima param imediatamente
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

  // Nós “processados” para desligamento
  const visitedDownRef = useRef<Set<UnitKey>>(new Set());
  const shutdownWasOnRef = useRef(false);
  useEffect(() => {
    if (!shutdownWasOnRef.current && shutdownRun) visitedDownRef.current = new Set();
    shutdownWasOnRef.current = shutdownRun;
  }, [shutdownRun]);

  // espelhar moedores no AUTO (se ambos sem defeito)
  useEffect(() => {
    if (!interlocksEnabled) return;
    const a = state.moedorMotorA;
    const b = state.moedorMotorB;
    if (a === MODE.DEFECT || b === MODE.DEFECT || a === b) return;
    const next: Mode =
      a === MODE.MANUAL || b === MODE.MANUAL
        ? MODE.MANUAL
        : a === MODE.AUTO || b === MODE.AUTO
        ? MODE.AUTO
        : MODE.OFF;
    setState((s) => ({ ...s, moedorMotorA: next, moedorMotorB: next }));
  }, [interlocksEnabled, state.moedorMotorA, state.moedorMotorB, setState]);

  // Tick dos timers: desligamento (downstream) e ligamento (upstream com contador no próprio nó)
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

        // SHUTDOWN
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
                if (next[d] == null) next[d] = TIMER_SECONDS; // contador no próprio nó que vai desligar
              }
            }
          }

          // Encerrar quando sem timers e tudo OFF
          if (Object.keys(next).length === 0) {
            const anyOn = ORDER.some((k) => isOnMode(state[k]));
            if (!anyOn) {
              setShutdownRun(false);
              visitedDownRef.current = new Set();
            }
          }

          return next;
        }

        // STARTUP (contador no próprio nó que vai ligar/mudar)
        if (startupRun) {
          // nó com timer expira => vira VERDE
          if (expired.length) {
            setState((s) => {
              const u = { ...s };
              for (const k of expired) {
                if (u[k] !== MODE.DEFECT) u[k] = MODE.MANUAL;
              }
              return u;
            });
          }

          const next: TimersRecord = { ...nextBase };

          // agendar o imediatamente acima: colocar AMARELO agora e timer nele
          for (const k of expired) {
            for (const up of immediateUpstream(k)) {
              // Só progride se não houver defeito downstream do "up"
              const ds = downstreamOf(up);
              const hasDefectBelow = ds.some((d) => state[d] === MODE.DEFECT);
              if (state[up] !== MODE.DEFECT && !hasDefectBelow) {
                setState((s) => ({ ...s, [up]: MODE.AUTO }));
                if (next[up] == null) next[up] = TIMER_SECONDS;
              }
            }
          }

          if (Object.keys(next).length === 0) {
            setStartupRun(false);
          }

          return next;
        }

        // Sem cascatas ativas
        return nextBase;
      });
    }, 1000);

    return () => clearInterval(id);
  // 👇 Adicionados setShutdownRun e setStartupRun nas dependências
  }, [timers, setTimers, setState, shutdownRun, startupRun, state, setShutdownRun, setStartupRun]);

  // Higiene: não limpar timers durante cascatas
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

  // Propagar timers para baixo quando detectar ON→OFF por outros motivos (desligamento assistido)
  const prevRef = useRef<StateRecord>(state);
  useEffect(() => {
    if (!(interlocksEnabled || shutdownRun)) {
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
  }, [interlocksEnabled, shutdownRun, state, setTimers]);
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
  return mode === MODE.MANUAL ? "Ligado (manual)" : mode === MODE.AUTO ? "Ligado (interlock)" : mode === MODE.DEFECT ? "Defeito" : "Pronto";
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
      <ToggleButton unitKey="esteiraMain" />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ToggleButton unitKey="moedorMotorA" />
        <ToggleButton unitKey="moedorMotorB" />
      </div>

      <ToggleButton unitKey="canoUnderMotor" />
      <ToggleButton unitKey="esteiraUnderCano" />
      <ToggleButton unitKey="separador" />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ToggleButton unitKey="esteiraEsquerda" />
        <ToggleButton unitKey="esteiraDireita" />
      </div>
    </div>
  );
}

function VisualList() {
  return (
    <div className="space-y-3">
      <ProcessBadge unitKey="esteiraMain" />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ProcessBadge unitKey="moedorMotorA" />
        <ProcessBadge unitKey="moedorMotorB" />
      </div>

      <ProcessBadge unitKey="canoUnderMotor" />
      <ProcessBadge unitKey="esteiraUnderCano" />
      <ProcessBadge unitKey="separador" />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ProcessBadge unitKey="esteiraEsquerda" />
        <ProcessBadge unitKey="esteiraDireita" />
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
      <p className="text-xs text-slate-500 mt-2">
        Alternar entre Automático/Manual. Espere os contadores terminarem para alterar.
      </p>
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
          Ligar grupo
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
          Desligar grupo
        </button>
      </div>

      {groupMode !== GROUP_MODE.AUTO && (
        <p className="text-[11px] text-slate-500 mt-2">
          Disponível apenas quando o Grupo estiver em <strong>AUTO</strong>.
        </p>
      )}

      <p className="text-xs text-slate-500 mt-2">
        Ao desligar grupo, não é exibido o contador de componentes desligados. Aguarde que todo o sistema será desligado.
      </p>
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
              Fluxo Industrial (V2.1.1)
            </h1>
            <p className="text-slate-700 mt-1">
              Painel de simulação com intertravamentos, timers de 3s e cascatas de liga/desliga (bottom-up / top-down), incluindo defeitos persistentes e espelhamento dos moedores.
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
            No modo <strong>Automático</strong>, os controles individuais ficam desabilitados.
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