import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

/**
 * Fluxo industrial — V1.3
 * Fix: ao desligar a ESTEIRA DIREITA, a ESQUERDA não desliga imediatamente.
 *      Se a irmã estiver em AUTO, recebe timer de 15s; os processos acima continuam desligando.
 */

// -----------------------------
// Modelo de Estado
// -----------------------------

const MODE = {
  OFF: "off",
  MANUAL: "manual",
  AUTO: "auto",
  DEFECT: "defect",
};

const ORDER = [
  "esteiraMain",
  "moedorMotorA",
  "moedorMotorB",
  "canoUnderMotor",
  "esteiraUnderCano",
  "separador",
  "esteiraEsquerda",
  "esteiraDireita",
];

const LABELS = {
  esteiraMain: "Esteira Principal",
  moedorMotorA: "Moedor - Motor A",
  moedorMotorB: "Moedor - Motor B",
  canoUnderMotor: "Cano (abaixo do moedor)",
  esteiraUnderCano: "Esteira abaixo do cano",
  separador: "Separador",
  esteiraEsquerda: "Esteira → Esquerda",
  esteiraDireita: "Esteira → Direita",
};

// -----------------------------
// Contexto Global do Sistema
// -----------------------------

const SystemContext = createContext(null);

function makeInitialState() {
  const s = {};
  ORDER.forEach((k) => (s[k] = MODE.OFF));
  return s;
}

function SystemProvider({ children }) {
  const [state, setState] = useState(makeInitialState());
  const [timers, setTimers] = useState({}); // { [unitKey]: secondsRemaining }

  useInterlocks(state, setState, timers, setTimers);

  const actions = useMemo(() => createActions(state, setState, timers, setTimers), [state, timers]);
  const value = useMemo(() => ({ state, actions, timers }), [state, actions, timers]);
  return <SystemContext.Provider value={value}>{children}</SystemContext.Provider>;
}

function useSystem() {
  const ctx = useContext(SystemContext);
  if (!ctx) throw new Error("useSystem deve ser usado dentro de <SystemProvider>");
  return ctx;
}

// -----------------------------
// Helpers
// -----------------------------

const idxOf = (k) => ORDER.indexOf(k);
const upstreamOf = (key) => ORDER.slice(0, idxOf(key));
const downstreamOf = (key) => ORDER.slice(idxOf(key) + 1);
const isOnMode = (mode) => mode === MODE.MANUAL || mode === MODE.AUTO;

const FINAL_LEFT = "esteiraEsquerda";
const FINAL_RIGHT = "esteiraDireita";
const isSiblingBelt = (a, b) =>
  (a === FINAL_LEFT && b === FINAL_RIGHT) || (a === FINAL_RIGHT && b === FINAL_LEFT);

function immediateDownstream(key) {
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
      return [FINAL_LEFT, FINAL_RIGHT];
    default:
      return [];
  }
}

// -----------------------------
// Ações (cliques)
// -----------------------------

function createActions(state, setState, timers, setTimers) {
  const isOn = (k) => isOnMode(state[k]);
  const isDefect = (k) => state[k] === MODE.DEFECT;

  const bulk = (entries) => setState((s) => ({ ...s, ...entries }));
  const setMode = (k, m) => setState((s) => ({ ...s, [k]: m }));

  // Timers
  const addTimers = (keys) =>
    setTimers((t) => {
      const next = { ...t };
      keys.forEach((k) => {
        if (state[k] !== MODE.AUTO) return; // só AUTO recebe timer
        next[k] = 15;
      });
      return next;
    });
  const clearTimer = (key) => setTimers((t) => { const n = { ...t }; delete n[key]; return n; });
  const clearTimersFor = (keys) => setTimers((t) => { const n = { ...t }; keys.forEach((k) => delete n[k]); return n; });

  // Bloqueios
  const hasDefectBelow = (key) => downstreamOf(key).some((k) => isDefect(k));
  const hasSiblingDefectBlockException = (key) => key === FINAL_LEFT || key === FINAL_RIGHT;

  const autoDownstreamAll = (key) => {
    const updates = {};
    for (const k of downstreamOf(key)) {
      const cur = state[k];
      if (cur === MODE.DEFECT || cur === MODE.MANUAL) continue;
      updates[k] = MODE.AUTO;
    }
    return updates;
  };

  const cancelTimersDownstream = (key) => {
    const ds = downstreamOf(key);
    clearTimersFor(ds);
  };

  // Desliga SOMENTE ACIMA (exclui a irmã de esteira final) — FIX V1.3
  const offAboveImmediate = (key) => {
    const updates = {};
    for (const k of upstreamOf(key)) {
      if (isSiblingBelt(key, k)) continue; // não derruba a irmã
      if (state[k] !== MODE.DEFECT) updates[k] = MODE.OFF;
    }
    if (Object.keys(updates).length) {
      bulk(updates);
      clearTimersFor(Object.keys(updates));
    }
  };

  const scheduleNextDownstream = (key) => {
    const next = immediateDownstream(key).filter((k) => state[k] === MODE.AUTO);
    if (next.length) addTimers(next);
  };

  const clickButton = (key) => {
    if (isDefect(key)) return;

    if (!isOn(key)) {
      if (!hasSiblingDefectBlockException(key)) {
        if (hasDefectBelow(key)) return;
      }
    }

    if (key === "esteiraMain") {
      if (isOn(key)) {
        setMode("esteiraMain", MODE.OFF);
        clearTimer("esteiraMain");
        scheduleNextDownstream("esteiraMain");
      } else {
        bulk({ ...autoDownstreamAll("esteiraMain"), esteiraMain: MODE.MANUAL });
        clearTimer("esteiraMain");
        cancelTimersDownstream("esteiraMain");
      }
      return;
    }

    if (key === "moedorMotorA" || key === "moedorMotorB") {
      const other = key === "moedorMotorA" ? "moedorMotorB" : "moedorMotorA";
      if (!isOn(key) && isDefect(other)) return;

      const anyOn = isOn("moedorMotorA") || isOn("moedorMotorB");
      if (anyOn) {
        bulk({ moedorMotorA: MODE.OFF, moedorMotorB: MODE.OFF });
        clearTimer("moedorMotorA");
        clearTimer("moedorMotorB");
        offAboveImmediate("moedorMotorA");
        scheduleNextDownstream("moedorMotorA");
      } else {
        bulk({ ...autoDownstreamAll("moedorMotorA"), moedorMotorA: MODE.MANUAL, moedorMotorB: MODE.MANUAL });
        clearTimer("moedorMotorA");
        clearTimer("moedorMotorB");
        cancelTimersDownstream("moedorMotorA");
      }
      return;
    }

    if (key === "separador") {
      if (isOn(key)) {
        setMode("separador", MODE.OFF);
        clearTimer("separador");
        offAboveImmediate("separador");
        scheduleNextDownstream("separador");
      } else {
        bulk({ ...autoDownstreamAll("separador"), separador: MODE.MANUAL });
        clearTimer("separador");
        cancelTimersDownstream("separador");
      }
      return;
    }

    // Esteiras finais
    if (key === FINAL_LEFT || key === FINAL_RIGHT) {
      const sibling = key === FINAL_LEFT ? FINAL_RIGHT : FINAL_LEFT;
      if (isOn(key)) {
        setMode(key, MODE.OFF);
        clearTimer(key);
        // se a irmã estiver em AUTO, agenda 15s nela
        setTimers((t) => {
          const n = { ...t };
          if (state[sibling] === MODE.AUTO && !n[sibling]) n[sibling] = 15;
          return n;
        });
        offAboveImmediate(key); // não derruba a irmã (fix)
      } else {
        setMode(key, MODE.MANUAL);
        clearTimer(key);
      }
      return;
    }

    // Estágios intermediários
    if (isOn(key)) {
      setMode(key, MODE.OFF);
      clearTimer(key);
      offAboveImmediate(key);
      scheduleNextDownstream(key);
    } else {
      bulk({ ...autoDownstreamAll(key), [key]: MODE.MANUAL });
      clearTimer(key);
      cancelTimersDownstream(key);
    }
    return;
  };

  const toggleDefect = (key) => {
    const cur = state[key];
    if (cur === MODE.DEFECT) {
      setMode(key, MODE.OFF);
      return;
    }

    const wasOn = cur === MODE.MANUAL || cur === MODE.AUTO;
    if (wasOn) {
      const nexts = immediateDownstream(key).filter((k) => state[k] === MODE.AUTO);
      if (nexts.length) addTimers(nexts);
    }

    if (key === "moedorMotorA" || key === "moedorMotorB") {
      const other = key === "moedorMotorA" ? "moedorMotorB" : "moedorMotorA";
      if (state[other] !== MODE.DEFECT) {
        setMode(other, MODE.OFF);
        clearTimer(other);
      }
    }

    offAboveImmediate(key);
    clearTimer(key);
    setMode(key, MODE.DEFECT);
  };

  return { clickButton, toggleDefect };
}

// -----------------------------
// Hook de Intertravamentos
// -----------------------------

function useInterlocks(state, setState, timers, setTimers) {
  // Espelhamento dos moedores (sem defeito)
  useEffect(() => {
    const a = state.moedorMotorA;
    const b = state.moedorMotorB;
    if (a === MODE.DEFECT || b === MODE.DEFECT) return;
    if (a !== b) {
      const next = a === MODE.MANUAL || b === MODE.MANUAL
        ? MODE.MANUAL
        : a === MODE.AUTO || b === MODE.AUTO
        ? MODE.AUTO
        : MODE.OFF;
      setState((s) => ({ ...s, moedorMotorA: next, moedorMotorB: next }));
    }
  }, [state.moedorMotorA, state.moedorMotorB, setState]);

  // Tick de timers (1s)
  useEffect(() => {
    const hasTimers = Object.keys(timers).length > 0;
    if (!hasTimers) return;

    const id = setInterval(() => {
      setTimers((prev) => {
        const next = {};
        const toTurnOff = [];
        for (const [k, v] of Object.entries(prev)) {
          const nv = v - 1;
          if (nv <= 0) toTurnOff.push(k);
          else next[k] = nv;
        }
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
        return next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [timers, setTimers, setState]);

  // Limpa qualquer timer ativo de peças que estejam OFF ou DEFECT
  useEffect(() => {
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
  }, [state, setTimers]);

  // Agendamento baseado em transições ON→OFF
  const prevRef = useRef(state);
  useEffect(() => {
    const prev = prevRef.current;
    const wasOn = (k) => isOnMode(prev[k]);
    const isOffNow = (k) => state[k] === MODE.OFF;

    const scheduleIfTurnedOff = (k) => {
      if (wasOn(k) && isOffNow(k)) {
        if (k === "moedorMotorA" || k === "moedorMotorB") {
          if (state.moedorMotorA === MODE.OFF && state.moedorMotorB === MODE.OFF) {
            setTimers((t) => (state.canoUnderMotor === MODE.AUTO && !t.canoUnderMotor ? { ...t, canoUnderMotor: 15 } : t));
          }
          return;
        }
        if (k === "separador") {
          setTimers((t) => {
            const add = {};
            if (state.esteiraEsquerda === MODE.AUTO && !t.esteiraEsquerda) add.esteiraEsquerda = 15;
            if (state.esteiraDireita === MODE.AUTO && !t.esteiraDireita) add.esteiraDireita = 15;
            return Object.keys(add).length ? { ...t, ...add } : t;
          });
          return;
        }
        const nexts = immediateDownstream(k).filter((d) => state[d] === MODE.AUTO);
        if (nexts.length) {
          setTimers((t) => {
            const add = { ...t };
            nexts.forEach((d) => {
              if (!add[d]) add[d] = 15;
            });
            return add;
          });
        }
      }
    };

    ORDER.forEach(scheduleIfTurnedOff);
    prevRef.current = state;
  }, [state, setTimers]);
}

// -----------------------------
// UI Helpers
// -----------------------------

function StatusDot({ mode }) {
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

function modeToText(mode) {
  return mode === MODE.MANUAL ? "Ligado (manual)" : mode === MODE.AUTO ? "Ligado (interlock)" : mode === MODE.DEFECT ? "Defeito" : "Pronto";
}

const ITEM_COMMON = [
  "flex items-center justify-between w-full text-left",
  "rounded-2xl px-4 py-3 border",
  "min-h-[56px]",
  "shadow-sm",
  "transition select-none",
];

function buttonClasses(mode, disabled) {
  const base = [
    ...ITEM_COMMON,
    disabled ? "cursor-not-allowed opacity-50" : "hover:shadow-md",
  ];
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

function badgeClasses(mode) {
  const base = [
    ...ITEM_COMMON,
    "cursor-pointer hover:shadow-md",
  ];
  const border = mode === MODE.MANUAL ? "border-green-500" : mode === MODE.AUTO ? "border-yellow-500" : mode === MODE.DEFECT ? "border-red-500" : "border-slate-300";
  const bg = mode === MODE.MANUAL ? "bg-green-50" : mode === MODE.AUTO ? "bg-yellow-50" : mode === MODE.DEFECT ? "bg-red-50" : "bg-white";
  return [...base, border, bg].join(" ");
}

function Countdown({ unitKey }) {
  const { timers } = useSystem();
  const remaining = timers[unitKey];
  if (!remaining) return null;
  return (
    <span className="text-[10px] ml-2 px-1.5 py-0.5 rounded bg-slate-100 border text-slate-600" title="Desligamento em">
      {remaining}s
    </span>
  );
}

// -----------------------------
// Controles (botões)
// -----------------------------

function ToggleButton({ unitKey }) {
  const { state, actions } = useSystem();
  const mode = state[unitKey];
  const disabled = mode === MODE.DEFECT;

  return (
    <button onClick={() => actions.clickButton(unitKey)} className={buttonClasses(mode, disabled)} aria-pressed={mode === MODE.MANUAL || mode === MODE.AUTO} aria-disabled={disabled}>
      <div className="flex items-center gap-3">
        <StatusDot mode={mode} />
        <span className="font-medium">{LABELS[unitKey]}</span>
      </div>
      <div className="flex items-center">
        <span className="text-xs px-2 py-1 rounded-full border bg-white">{modeToText(mode)}</span>
        {(state[unitKey]!==MODE.OFF && state[unitKey]!==MODE.DEFECT) && <Countdown unitKey={unitKey} />}
      </div>
    </button>
  );
}

// -----------------------------
// Processos (visuais)
// -----------------------------

function ProcessBadge({ unitKey }) {
  const { state, actions } = useSystem();
  const mode = state[unitKey];

  return (
    <div role="button" onClick={() => actions.toggleDefect(unitKey)} className={badgeClasses(mode)} title={mode === MODE.DEFECT ? "Clique para limpar defeito" : "Clique para marcar defeito"}>
      <div className="flex items-center gap-3">
        <StatusDot mode={mode} />
        <span className="font-medium">{LABELS[unitKey]}</span>
      </div>
      <div className="flex items-center">
        <span className="text-xs px-2 py-1 rounded-full border bg-white">{modeToText(mode)}</span>
        {(state[unitKey]!==MODE.OFF && state[unitKey]!==MODE.DEFECT) && <Countdown unitKey={unitKey} />}
      </div>
    </div>
  );
}

// -----------------------------
// Listas
// -----------------------------

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
        <ToggleButton unitKey={FINAL_LEFT} />
        <ToggleButton unitKey={FINAL_RIGHT} />
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
        <ProcessBadge unitKey={FINAL_LEFT} />
        <ProcessBadge unitKey={FINAL_RIGHT} />
      </div>
    </div>
  );
}

// -----------------------------
// Painel Principal
// -----------------------------

export default function IndustrialFlowPanel() {
  return (
    <SystemProvider>
      <div className="min-h-screen w-full bg-gradient-to-b from-slate-50 to-slate-100 p-6">
        <main className="mx-auto max-w-5xl">
          <header className="mb-6">
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Fluxo Industrial (V1.3)</h1>
            <p className="text-slate-600 mt-1">Interlocks completos • Timers só para AUTO • Defeitos persistentes • Cascata em defeito • Pares A/B e E/D</p>
          </header>

          <section className="grid grid-cols-1 md:grid-cols-2 gap-5 items-start">
            <Card title="Controles (Botões)">
              <ControlsList />
            </Card>

            <Card title="Processos (Visuais)">
              <VisualList />
            </Card>
          </section>

          <p className="text-slate-600 mt-6">Clique em um processo para marcar/limpar <strong>defeito</strong> (vermelho). O fluxo só pode ser ligado pelos botões.</p>
        </main>
      </div>
    </SystemProvider>
  );
}

function Card({ title, children }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
      <h2 className="text-lg font-semibold mb-3">{title}</h2>
      {children}
    </div>
  );
}