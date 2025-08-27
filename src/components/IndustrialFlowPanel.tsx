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

/* =====================================================================
   Tipos
   ===================================================================== */

type Mode = "off" | "manual" | "auto" | "defect";
type GroupMode = "auto" | "manu";

const MODE = {
  OFF: "off",
  MANUAL: "manual",
  AUTO: "auto",
  DEFECT: "defect",
} as const;

const GROUP_MODE = {
  AUTO: "auto",
  MANU: "manu",
} as const;

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

type UnitKey = typeof ORDER[number];

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

/* =====================================================================
   Contexto Global do Sistema
   ===================================================================== */

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

  // Mantém a cascata viva após iniciar o desligamento
  const [shutdownRun, setShutdownRun] = useSavedState<boolean>("flow_shutdown_active", false);

  useInterlocks(state, setState, timers, setTimers, groupMode, shutdownRun, setShutdownRun);

  const actions = useMemo(
    () =>
      createActions(
        state,
        setState,
        timers,
        setTimers,
        groupMode,
        setGroupMode,
        setShutdownRun
      ),
    [state, timers, groupMode, setShutdownRun]
  );

  const value = useMemo<SystemContextValue>(
    () => ({ state, actions, timers, groupMode }),
    [state, actions, timers, groupMode]
  );

  return <SystemContext.Provider value={value}>{children}</SystemContext.Provider>;
}

function useSystem(): SystemContextValue {
  const ctx = useContext(SystemContext);
  if (!ctx) throw new Error("useSystem deve ser usado dentro de <SystemProvider>");
  return ctx;
}

/* =====================================================================
   Helpers
   ===================================================================== */

const idxOf = (k: UnitKey) => ORDER.indexOf(k);
const upstreamOf = (key: UnitKey): UnitKey[] => ORDER.slice(0, idxOf(key)) as UnitKey[];
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
const isOnMode = (m: Mode) => m === MODE.MANUAL || m === MODE.AUTO;

const FINAL_LEFT: UnitKey = "esteiraEsquerda";
const FINAL_RIGHT: UnitKey = "esteiraDireita";

/** Encontra todos os nós "topo ligado" (sem upstream ON) para iniciar cascata em todos os ramos */
function topmostOnSeeds(s: StateRecord): UnitKey[] {
  const seeds: UnitKey[] = [];
  for (const k of ORDER) {
    const on = s[k] === MODE.MANUAL || s[k] === MODE.AUTO;
    if (!on) continue;
    const hasUpOn = upstreamOf(k).some((u) => s[u] === MODE.MANUAL || s[u] === MODE.AUTO);
    if (!hasUpOn) seeds.push(k);
  }
  return seeds;
}

/* =====================================================================
   Ações (cliques) + Grupo
   ===================================================================== */

function createActions(
  state: StateRecord,
  setState: React.Dispatch<React.SetStateAction<StateRecord>>,
  timers: TimersRecord,
  setTimers: React.Dispatch<React.SetStateAction<TimersRecord>>,
  groupMode: GroupMode,
  setGroupMode: React.Dispatch<React.SetStateAction<GroupMode>>,
  setShutdownRun: React.Dispatch<React.SetStateAction<boolean>>
): Actions {
  const isDefect = (k: UnitKey) => state[k] === MODE.DEFECT;

  const bulk = (entries: Partial<StateRecord>) =>
    setState((s) => ({ ...s, ...entries }));
  const setMode = (k: UnitKey, m: Mode) =>
    setState((s) => ({ ...s, [k]: m }));

  const TIMER_SECONDS = 3;

  const addTimers = (keys: UnitKey[]) =>
    setTimers((t) => {
      const next: TimersRecord = { ...t };
      keys.forEach((k) => {
        next[k] = TIMER_SECONDS;
      });
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
    setGroupMode(nextMode);
  };

  // Ligar grupo: liga TC03 e TC04 (MANUAL) e põe montante em AUTO
  const autoUpstreamAll = (key: UnitKey): Partial<StateRecord> => {
    const updates: Partial<StateRecord> = {};
    for (const k of upstreamOf(key)) {
      if (state[k] !== MODE.DEFECT) updates[k] = MODE.AUTO;
    }
    return updates;
  };

  const cancelTimersUpstream = (key: UnitKey) => clearTimersFor(upstreamOf(key));

  const groupPowerOn = () => {
    if (groupMode !== GROUP_MODE.AUTO) return;
    const upsLeft = autoUpstreamAll(FINAL_LEFT);
    const upsRight = autoUpstreamAll(FINAL_RIGHT);
    bulk({
      ...upsLeft,
      ...upsRight,
      [FINAL_LEFT]: MODE.MANUAL,
      [FINAL_RIGHT]: MODE.MANUAL,
    });
    clearTimer(FINAL_LEFT);
    clearTimer(FINAL_RIGHT);
    cancelTimersUpstream(FINAL_LEFT);
    cancelTimersUpstream(FINAL_RIGHT);
    setShutdownRun(false);
  };

  // Desligar grupo: inicia cascata TOP→DOWN (3s) em TODOS os ramos "topo ligado"
  const groupPowerOff = () => {
    if (groupMode !== GROUP_MODE.AUTO) return;

    const seeds = topmostOnSeeds(state);
    if (seeds.length === 0) return;

    setShutdownRun(true);
    addTimers(seeds);
  };

  /* ---------------- Clique por unidade ------------------------ */
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
      const cur = s[key];
      const next: Mode = cur === MODE.MANUAL ? MODE.OFF : MODE.MANUAL;
      return { ...s, [key]: next };
    });
    clearTimer(key);
  };

  const clickButton = (key: UnitKey) => {
    if (groupMode === GROUP_MODE.AUTO) return;
    return clickManualOnly(key);
  };

  const toggleDefect = (key: UnitKey) => {
    if (groupMode === GROUP_MODE.AUTO) return;

    const cur = state[key];
    if (cur === MODE.DEFECT) {
      setMode(key, MODE.OFF);
      return;
    }
    setMode(key, MODE.DEFECT);
  };

  return {
    clickButton,
    toggleDefect,
    setGroupMode: setGroupModeSafe,
    groupPowerOn,
    groupPowerOff,
  };
}

/* =====================================================================
   Hook de Intertravamentos
   ===================================================================== */

function useInterlocks(
  state: StateRecord,
  setState: React.Dispatch<React.SetStateAction<StateRecord>>,
  timers: TimersRecord,
  setTimers: React.Dispatch<React.SetStateAction<TimersRecord>>,
  groupMode: GroupMode,
  shutdownRun: boolean,
  setShutdownRun: React.Dispatch<React.SetStateAction<boolean>>
) {
  const interlocksEnabled = groupMode === GROUP_MODE.AUTO;
  const TIMER_SECONDS = 3;

  // ✅ NOVO: rastreia quais nós já foram "processados" na cascata (timer expirado)
  const visitedRef = useRef<Set<UnitKey>>(new Set());
  const shutdownWasOnRef = useRef<boolean>(false);

  // Reseta 'visited' quando iniciamos uma cascata
  useEffect(() => {
    if (!shutdownWasOnRef.current && shutdownRun) {
      visitedRef.current = new Set();
    }
    shutdownWasOnRef.current = shutdownRun;
  }, [shutdownRun]);

  // 1) Espelhamento dos moedores (apenas no AUTO e sem defeito)
  useEffect(() => {
    if (!interlocksEnabled) return;
    const a = state.moedorMotorA;
    const b = state.moedorMotorB;
    if (a === MODE.DEFECT || b === MODE.DEFECT) return;
    if (a !== b) {
      const next: Mode =
        a === MODE.MANUAL || b === MODE.MANUAL
          ? MODE.MANUAL
          : a === MODE.AUTO || b === MODE.AUTO
          ? MODE.AUTO
          : MODE.OFF;
      setState((s) => ({ ...s, moedorMotorA: next, moedorMotorB: next }));
    }
  }, [interlocksEnabled, state.moedorMotorA, state.moedorMotorB, setState]);

  // 2) Tick de timers (1s) — propaga downstream e preenche "lacunas" (OFF) pela fronteira visitada
  useEffect(() => {
    const hasTimers = Object.keys(timers).length > 0;
    if (!hasTimers) return;

    const id = setInterval(() => {
      setTimers((prev) => {
        const nextBase: TimersRecord = {};
        const toTurnOff: UnitKey[] = [];

        // contagem regressiva
        for (const [k, v] of Object.entries(prev) as [UnitKey, number][]) {
          const nv = v - 1;
          if (nv <= 0) {
            toTurnOff.push(k);
          } else {
            nextBase[k] = nv;
          }
        }

        // Desliga peças ON/AUTO normalmente
        if (toTurnOff.length) {
          setState((s) => {
            const updates = { ...s };
            for (const key of toTurnOff) {
              if (updates[key] === MODE.MANUAL || updates[key] === MODE.AUTO) {
                updates[key] = MODE.OFF;
              }
            }
            return updates;
          });
        }

        // ---- NOVO: marca nós "processados" (timer expirou)
        if (shutdownRun && toTurnOff.length) {
          const v = new Set(visitedRef.current);
          for (const k of toTurnOff) v.add(k);
          visitedRef.current = v;
        }

        // Construção do próximo mapa de timers
        let next: TimersRecord = { ...nextBase };

        // (a) Propagação normal: quando um estágio "encerra", agenda downstream
        if (shutdownRun && toTurnOff.length) {
          for (const key of toTurnOff) {
            for (const d of immediateDownstream(key)) {
              if (next[d] == null) next[d] = TIMER_SECONDS;
            }
          }
        }

        // (b) ✅ NOVO: preenche "lacunas" — se todos os montantes de um nó já
        // foram processados (visited), mas ele mesmo ainda não tem timer,
        // iniciamos o timer dele para a cascata não "parar" em trechos OFF.
        if (shutdownRun) {
          const visited = visitedRef.current;
          // Vamos agendar APENAS o próximo "nível" por tick
          const shouldStart: UnitKey[] = [];
          for (const k of ORDER) {
            if (visited.has(k)) continue;     // já processado
            if (next[k] != null) continue;    // já tem timer correndo
            const ups = upstreamOf(k);
            // Todos os montantes já processados?
            const allUpsVisited = ups.every((u) => visited.has(u));
            if (allUpsVisited) {
              shouldStart.push(k);
            }
          }
          // Agende somente o primeiro nível fronteira encontrado,
          // preservando o ritmo top→down (3s entre etapas).
          // (Todos os nós deste nível compartilham os mesmos montantes.)
          if (shouldStart.length) {
            for (const k of shouldStart) {
              next[k] = TIMER_SECONDS;
            }
          }
        }

        return next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [timers, setTimers, setState, shutdownRun]);

  // 3) Higiene — não limpar timers durante cascata
  useEffect(() => {
    if (shutdownRun) return;

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
  }, [state, setTimers, shutdownRun]);

  // 4) Cascata por transição ON→OFF (mantida; ajuda quando há mudanças de estado)
  const prevRef = useRef<StateRecord>(state);
  useEffect(() => {
    if (!(interlocksEnabled || shutdownRun)) {
      prevRef.current = state;
      return;
    }

    const prev = prevRef.current;
    const wasOn = (k: UnitKey) => (prev[k] === MODE.MANUAL || prev[k] === MODE.AUTO);
    const isOffNow = (k: UnitKey) => state[k] === MODE.OFF;

    const scheduleIfJustTurnedOff = (k: UnitKey) => {
      if (wasOn(k) && isOffNow(k)) {
        setTimers((t) => {
          const add: TimersRecord = { ...t };
          for (const d of immediateDownstream(k)) {
            if (!add[d]) add[d] = TIMER_SECONDS;
          }
          return add;
        });
      }
    };

    ORDER.forEach(scheduleIfJustTurnedOff);
    prevRef.current = state;
  }, [interlocksEnabled, shutdownRun, state, setTimers]);

  // 5) Encerramento da cascata
  useEffect(() => {
    if (!shutdownRun) return;
    const noTimers = Object.keys(timers).length === 0;
    const anyOn = ORDER.some((k) => state[k] === MODE.MANUAL || state[k] === MODE.AUTO);
    if (noTimers && !anyOn) {
      setShutdownRun(false);
      // limpa o histórico para a próxima vez
      visitedRef.current = new Set();
    }
  }, [shutdownRun, timers, state, setShutdownRun]);
}

/* =====================================================================
   UI Helpers
   ===================================================================== */

function StatusDot({ mode }: { mode: Mode }) {
  const cls =
    mode === MODE.MANUAL
      ? "bg-green-500 border-green-600"
      : mode === MODE.AUTO
      ? "bg-yellow-400 border-yellow-500"
      : mode === MODE.DEFECT
      ? "bg-red-500 border-red-600"
      : "bg-white border-gray-300";
  return <span className={["inline-block size-3 rounded-full border", cls].join(" ")} />;
}

function modeToText(mode: Mode) {
  return mode === MODE.MANUAL
    ? "Ligado (manual)"
    : mode === MODE.AUTO
    ? "Ligado (interlock)"
    : mode === MODE.DEFECT
    ? "Defeito"
    : "Pronto";
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
  if (!remaining) return null;
  return (
    <span
      className="text-[10px] ml-2 px-1.5 py-0.5 rounded bg-slate-100 border text-slate-600"
      title="Desligamento em"
    >
      {remaining}s
    </span>
  );
}

/* =====================================================================
   Controles (botões)
   ===================================================================== */

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
        <span className="font-medium">{LABELS[unitKey]}</span>
      </div>
      <div className="flex items-center">
        <span className="text-xs px-2 py-1 rounded-full border bg-white">{modeToText(mode)}</span>
        {state[unitKey] !== MODE.OFF && state[unitKey] !== MODE.DEFECT && (
          <Countdown unitKey={unitKey} />
        )}
      </div>
    </button>
  );
}

/* =====================================================================
   Processos (visuais)
   ===================================================================== */

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
        <span className="font-medium">{LABELS[unitKey]}</span>
      </div>
      <div className="flex items-center">
        <span className="text-xs px-2 py-1 rounded-full border bg-white">{modeToText(mode)}</span>
        {state[unitKey] !== MODE.OFF && state[unitKey] !== MODE.DEFECT && (
          <Countdown unitKey={unitKey} />
        )}
      </div>
    </div>
  );
}

/* =====================================================================
   Listas
   ===================================================================== */

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

/* =====================================================================
   Seletor de Grupo (AUTO / MANU) + On/Off
   ===================================================================== */

function GroupSelector() {
  const { groupMode, actions } = useSystem();
  const isAuto = groupMode === GROUP_MODE.AUTO;

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
      <h3 className="text-sm font-semibold mb-2">Grupo</h3>
      <div className="flex gap-2">
        <button
          type="button"
          aria-pressed={isAuto}
          onClick={() => actions.setGroupMode(GROUP_MODE.AUTO)}
          className={[
            "px-3 py-1.5 rounded-xl border text-sm transition",
            isAuto
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
          className={[
            "px-3 py-1.5 rounded-xl border text-sm transition",
            !isAuto
              ? "bg-slate-900 text-white border-slate-900 shadow-sm"
              : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50",
          ].join(" ")}
        >
          Manual
        </button>
      </div>
      <p className="text-xs text-slate-500 mt-2">
        Alternar Automático/Manual mantém os processos e timers atuais.
      </p>
    </div>
  );
}

function GroupPowerBox() {
  const { actions, groupMode } = useSystem();
  const disabled = groupMode !== GROUP_MODE.AUTO;

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
      <h3 className="text-sm font-semibold mb-2">On/Off</h3>
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

      {disabled && (
        <p className="text-[11px] text-slate-500 mt-2">
          Disponível apenas quando o Grupo estiver em <strong>AUTO</strong>.
        </p>
      )}

      {/* Aviso solicitado abaixo de On/Off */}
      <p className="text-xs text-slate-500 mt-2">
        Ao desligar grupo, não é exibido o contador de componentes desligados. Aguarde que todo o sistema será desligado.
      </p>
    </div>
  );
}

/* =====================================================================
   Painel Principal
   ===================================================================== */

export default function IndustrialFlowPanel() {
  return (
    <SystemProvider>
      <div className="min-h-screen w-full bg-gradient-to-b from-slate-50 to-slate-100 p-6">
        <main className="mx-auto max-w-5xl">
          <header className="mb-6">
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
              Fluxo Industrial (V1.9 — Cascata Top→Down resiliente)
            </h1>
            <p className="text-slate-600 mt-1">
              Interlocks no AUTO • Timers de 3s • Defeitos persistentes • Desligamento{" "}
              <em>de cima para baixo</em> • Ligar TC03/TC04 aciona toda a montante • Cascata mantém-se ao alternar Automático/Manual •
              Onda de desligamento continua mesmo com trechos já OFF
            </p>

            {/* Grupo + On/Off lado a lado */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
              <GroupSelector />
              <GroupPowerBox />
            </div>
          </header>

          <section className="grid grid-cols-1 md:grid-cols-2 gap-5 items-start">
            <Card title="Comandos">
              <ControlsList />
            </Card>

            <Card title="Alarmes">
              <VisualList />
            </Card>
          </section>

          <p className="text-slate-600 mt-6">
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
      <h2 className="text-lg font-semibold mb-3">{title}</h2>
      {children}
    </div>
  );
}