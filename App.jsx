import { useState, useMemo } from "react";
import {
  ComposedChart, LineChart, BarChart, Bar, Line, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine
} from "recharts";

// ─── 定数 ──────────────────────────────────────────────────────────
const AREAS = {
  北海道: { psh: 3.3, br: 1478, er: 19.12, rr: 3.49 },
  東北:   { psh: 3.5, br: 1468, er: 17.85, rr: 3.49 },
  東京:   { psh: 3.8, br: 1533, er: 17.78, rr: 3.49 },
  中部:   { psh: 4.0, br: 1478, er: 17.56, rr: 3.49 },
  北陸:   { psh: 3.2, br: 1423, er: 17.22, rr: 3.49 },
  関西:   { psh: 4.1, br: 1452, er: 16.89, rr: 3.49 },
  中国:   { psh: 3.9, br: 1478, er: 17.12, rr: 3.49 },
  四国:   { psh: 4.2, br: 1456, er: 17.45, rr: 3.49 },
  九州:   { psh: 4.3, br: 1423, er: 16.78, rr: 3.49 },
  沖縄:   { psh: 4.5, br: 1489, er: 17.95, rr: 3.49 },
};

const PROFILES = {
  factory:    { label: "工場（昼間操業）",   lf: 0.65, scr: 0.85 },
  office:     { label: "オフィスビル",       lf: 0.50, scr: 0.75 },
  commercial: { label: "商業施設",           lf: 0.55, scr: 0.65 },
  hospital:   { label: "病院・24時間施設",   lf: 0.75, scr: 0.60 },
  warehouse:  { label: "倉庫・物流施設",     lf: 0.45, scr: 0.80 },
};

// ─── フォーマット ──────────────────────────────────────────────────
const fmtY = v => {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)}億円`;
  if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(1)}万円`;
  return `${sign}${Math.round(abs).toLocaleString()}円`;
};
const fmtN = v => Math.round(v).toLocaleString();
const fmtM = v => `${Math.round(v / 1e4).toLocaleString()}万円`;

// ─── シミュレーションエンジン ──────────────────────────────────────
function simulate(p) {
  const a = AREAS[p.area];
  const prof = PROFILES[p.demandProfile];
  if (!a || !prof) return null;

  const pfDisc = (p.powerFactor - 85) * 0.002;
  const annualKwh = p.contractPower * prof.lf * 8760;
  const baseBasic   = p.contractPower * a.br * 12 * (1 - pfDisc);
  const baseEnergy  = annualKwh * a.er;
  const baseRenew   = annualKwh * a.rr;
  const baseCost    = baseBasic + baseEnergy + baseRenew;

  // 太陽光発電量（初年度）
  const genY1 = p.solarCapacity * a.psh * 365 * (p.performanceRatio / 100);

  // 自家消費・蓄電池（初年度）
  const directSC1 = Math.min(genY1 * prof.scr, annualKwh);
  let batContrib1 = 0;
  if (p.hasBattery && p.batteryCapacity > 0) {
    const excess = genY1 - directSC1;
    const maxThru = p.batteryCapacity * 365 * (p.chargeEff / 100);
    batContrib1 = Math.min(excess * 0.65, maxThru) * (p.dischargeEff / 100);
    batContrib1 = Math.min(batContrib1, annualKwh - directSC1);
  }
  const totalSC1 = directSC1 + batContrib1;
  const feedIn1 = Math.max(0, genY1 - totalSC1);
  const fitInc1 = p.fitType === "self" ? 0 : feedIn1 * p.fitRate;
  const eSave1  = totalSC1 * a.er;
  const rSave1  = totalSC1 * a.rr;
  const maint1  = p.solarMaint + (p.hasBattery ? p.batMaint : 0);
  const annSavings1 = eSave1 + rSave1 + fitInc1 - maint1;

  // 初期投資
  const initInv = p.solarCost + (p.hasBattery ? p.batCost : 0) + p.gridConnCost - p.subsidyAmount;
  const annDep  = initInv / p.depreciation;

  // ローン返済額（元利均等）
  let annLoan = 0;
  if (p.financingType === "loan" && p.loanYears > 0 && initInv > 0) {
    const mr = p.loanRate / 100 / 12;
    const n  = p.loanYears * 12;
    annLoan = mr > 0
      ? initInv * mr * Math.pow(1 + mr, n) / (Math.pow(1 + mr, n) - 1) * 12
      : initInv / p.loanYears;
  }

  // 年次シミュレーション
  const years = [];
  let cumCF = -initInv;
  let paybackYear = null;

  for (let yr = 1; yr <= p.analysisYears; yr++) {
    const sdeg = Math.pow(1 - p.solarDeg / 100, yr - 1);
    const bdeg = p.hasBattery ? Math.pow(1 - p.batDeg / 100, yr - 1) : 1;
    const esc  = Math.pow(1 + p.elecEsc / 100, yr - 1);

    const gen  = genY1 * sdeg;
    const dsc  = Math.min(gen * prof.scr, annualKwh);
    let bc = 0;
    if (p.hasBattery && p.batteryCapacity > 0) {
      const exc = gen - dsc;
      const mt  = p.batteryCapacity * bdeg * 365 * (p.chargeEff / 100);
      bc = Math.min(exc * 0.65, mt) * (p.dischargeEff / 100);
      bc = Math.min(bc, annualKwh - dsc);
    }
    const tsc   = dsc + bc;
    const fi    = Math.max(0, gen - tsc);
    const eS    = tsc * a.er * esc;
    const rS    = tsc * a.rr * esc;
    const fitI  = p.fitType === "self" ? 0 : fi * p.fitRate;
    const annCF = eS + rS + fitI - maint1;
    const loan  = (p.financingType === "loan" && yr <= p.loanYears) ? annLoan : 0;

    cumCF += annCF;
    if (paybackYear === null && cumCF >= 0) paybackYear = yr;

    const baseEsc = baseCost * esc;
    years.push({
      year: yr,
      annCF:    Math.round(annCF / 1e4),
      cumCF:    Math.round(cumCF / 1e4),
      netCF:    Math.round((annCF - loan) / 1e4),
      gen:      Math.round(gen),
      tsc:      Math.round(tsc),
      fi:       Math.round(fi),
      baseEsc:  Math.round(baseEsc / 1e4),
      afterEsc: Math.round((baseEsc - eS - rS - fitI + maint1) / 1e4),
      dep:      Math.round(annDep / 1e4),
    });
  }

  // NPV
  let npv = -initInv;
  years.forEach((y, i) => {
    npv += (y.annCF * 1e4) / Math.pow(1 + p.discountRate / 100, i + 1);
  });

  // IRR（二分探索）
  let irr = null;
  if (annSavings1 > 0) {
    let lo = -0.99, hi = 10;
    for (let it = 0; it < 200; it++) {
      const mid = (lo + hi) / 2;
      let npvM = -initInv;
      years.forEach((y, i) => { npvM += (y.annCF * 1e4) / Math.pow(1 + mid, i + 1); });
      if (Math.abs(npvM) < 500) { irr = mid * 100; break; }
      if (npvM > 0) lo = mid; else hi = mid;
    }
  }

  const co2 = totalSC1 * 0.000453;
  const solarUnitCost = p.solarCapacity > 0 ? p.solarCost / p.solarCapacity / 1e4 : 0;

  return {
    baseCost, baseBasic, baseEnergy, baseRenew,
    annualKwh, genY1, totalSC1, feedIn1, fitInc1,
    eSave1, rSave1, maint1, annSavings1,
    initInv, annLoan, annDep, paybackYear, npv, irr, co2,
    solarUnitCost, years, a, prof,
  };
}

// ─── サブコンポーネント ────────────────────────────────────────────
const Panel = ({ title, children, accent }) => (
  <div style={{
    background: "#111827", border: `1px solid ${accent ? "#f59e0b44" : "#1e293b"}`,
    borderRadius: 12, padding: "20px",
    boxShadow: accent ? "0 0 20px #f59e0b0a" : "none"
  }}>
    <h3 style={{
      margin: "0 0 16px", fontSize: 11, fontWeight: 600, color: "#64748b",
      textTransform: "uppercase", letterSpacing: "1px",
      paddingBottom: 10, borderBottom: "1px solid #1e293b"
    }}>{title}</h3>
    {children}
  </div>
);

const IG = ({ label, hint, children }) => (
  <div style={{ marginBottom: 14 }}>
    <label style={{ display: "block", fontSize: 11, fontWeight: 600, marginBottom: 5, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.5px" }}>{label}</label>
    {children}
    {hint && <p style={{ margin: "4px 0 0", fontSize: 11, color: "#475569", lineHeight: 1.4 }}>{hint}</p>}
  </div>
);

const NI = ({ value, onChange, min, max, step, unit, readOnly }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    <input
      type="number" value={value}
      onChange={e => !readOnly && onChange(Number(e.target.value))}
      min={min} max={max} step={step ?? 1} readOnly={readOnly}
      style={{
        flex: 1, padding: "8px 10px", borderRadius: 6,
        background: readOnly ? "#0d1523" : "#1e293b",
        border: "1px solid #334155", color: readOnly ? "#64748b" : "#e2e8f0",
        fontSize: 14, fontFamily: "'IBM Plex Mono', monospace", outline: "none",
        cursor: readOnly ? "default" : "auto"
      }}
    />
    {unit && <span style={{ color: "#64748b", fontSize: 12, whiteSpace: "nowrap", minWidth: 50 }}>{unit}</span>}
  </div>
);

const Sel = ({ value, onChange, options }) => (
  <select value={value} onChange={e => onChange(e.target.value)}
    style={{
      width: "100%", padding: "8px 10px", borderRadius: 6,
      background: "#1e293b", border: "1px solid #334155",
      color: "#e2e8f0", fontSize: 13, fontFamily: "inherit", outline: "none", cursor: "pointer"
    }}>
    {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
  </select>
);

const Toggle = ({ value, onChange, options }) => (
  <div style={{ display: "flex", gap: 6 }}>
    {options.map(([label, val]) => (
      <button key={val} onClick={() => onChange(val)} style={{
        flex: 1, padding: "8px 6px", borderRadius: 6, cursor: "pointer",
        border: `1px solid ${value === val ? "#f59e0b" : "#334155"}`,
        background: value === val ? "rgba(245,158,11,0.12)" : "#1e293b",
        color: value === val ? "#fbbf24" : "#94a3b8",
        fontFamily: "inherit", fontSize: 13, transition: "all 0.15s"
      }}>{label}</button>
    ))}
  </div>
);

const KpiCard = ({ icon, label, value, sub, color, warn }) => (
  <div style={{
    background: "#111827", border: `1px solid ${warn ? "#ef444433" : "#1e293b"}`,
    borderRadius: 12, padding: "18px 16px"
  }}>
    <div style={{ fontSize: 18, marginBottom: 6 }}>{icon}</div>
    <div style={{ fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.8px", marginBottom: 4 }}>{label}</div>
    <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 21, fontWeight: 700, color, lineHeight: 1.2 }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: "#475569", marginTop: 3 }}>{sub}</div>}
  </div>
);

const TT = ({ active, payload, label, unit = "万円" }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: "#1e293b", border: "1px solid #334155",
      borderRadius: 8, padding: "10px 14px", fontSize: 12
    }}>
      <p style={{ margin: "0 0 6px", color: "#94a3b8" }}>{label}年目</p>
      {payload.map(p => (
        <p key={p.name} style={{ margin: "2px 0", color: p.color }}>
          {p.name}: {p.value?.toLocaleString()}{unit}
        </p>
      ))}
    </div>
  );
};

// ─── メインコンポーネント ──────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState(0);
  const [p, setP] = useState({
    area: "東京", demandProfile: "factory",
    contractPower: 500, powerFactor: 90,
    solarCapacity: 200, performanceRatio: 75, solarDeg: 0.5,
    hasBattery: false, batteryCapacity: 200,
    chargeEff: 95, dischargeEff: 95, batDeg: 2.0,
    fitType: "fit", fitRate: 10,
    gridConnCost: 500000,
    solarCost: 20000000, batCost: 8000000,
    solarMaint: 200000, batMaint: 80000,
    subsidyAmount: 0, depreciation: 17,
    financingType: "cash", loanRate: 2.0, loanYears: 10,
    discountRate: 3, elecEsc: 2, analysisYears: 20,
  });

  const upd = k => v => setP(prev => ({ ...prev, [k]: v }));
  const r = useMemo(() => simulate(p), [p]);

  const TABS = [
    { label: "基本情報", icon: "🏭" },
    { label: "太陽光・蓄電池", icon: "☀️" },
    { label: "料金・売電", icon: "💴" },
    { label: "財務設定", icon: "📋" },
    { label: "シミュレーション結果", icon: "📊" },
  ];

  return (
    <div style={{ fontFamily: "'Noto Sans JP', 'Hiragino Sans', sans-serif", background: "#0a0f1c", minHeight: "100vh", color: "#e2e8f0" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&display=swap');
        * { box-sizing: border-box; }
        input[type=number]:focus { border-color: #f59e0b !important; }
        select:focus { border-color: #f59e0b !important; }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: #0d1523; }
        ::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
      `}</style>

      {/* ヘッダー */}
      <div style={{ background: "linear-gradient(135deg, #0d1523 0%, #0f1e30 100%)", borderBottom: "1px solid #1e293b", padding: "14px 28px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: "linear-gradient(135deg, #f59e0b, #d97706)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>⚡</div>
          <div>
            <h1 style={{ margin: 0, fontSize: 17, fontWeight: 700, letterSpacing: "-0.3px", color: "#f1f5f9" }}>高圧受電 電気代削減シミュレーター</h1>
            <p style={{ margin: 0, fontSize: 11, color: "#475569" }}>太陽光発電・蓄電池 投資回収分析ツール（参考値）</p>
          </div>
        </div>
        <div style={{ fontSize: 11, color: "#334155", textAlign: "right" }}>
          <div>料金単価は2024年度推計</div>
          <div>実際の契約内容に合わせて調整してください</div>
        </div>
      </div>

      {/* クイック KPI バー */}
      {r && (
        <div style={{ background: "#0d1523", borderBottom: "1px solid #1e293b", padding: "10px 28px", display: "flex", gap: 28, overflowX: "auto" }}>
          {[
            { l: "現状年間電気料金", v: fmtY(r.baseCost), c: "#ef4444" },
            { l: "年間削減額（初年度）", v: fmtY(r.annSavings1), c: "#10b981" },
            { l: "実質初期投資", v: fmtY(r.initInv), c: "#94a3b8" },
            { l: "単純回収年数", v: r.paybackYear ? `${r.paybackYear}年` : "分析期間内未回収", c: "#f59e0b" },
            { l: "NPV", v: fmtY(r.npv), c: r.npv >= 0 ? "#10b981" : "#ef4444" },
            { l: "IRR", v: r.irr !== null ? `${r.irr.toFixed(2)}%` : "N/A", c: "#a78bfa" },
            { l: "CO₂削減（初年度）", v: `${r.co2.toFixed(1)} t/年`, c: "#34d399" },
          ].map(k => (
            <div key={k.l} style={{ flexShrink: 0 }}>
              <div style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 1 }}>{k.l}</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 15, fontWeight: 700, color: k.c }}>{k.v}</div>
            </div>
          ))}
        </div>
      )}

      {/* タブナビゲーション */}
      <div style={{ background: "#0d1523", borderBottom: "1px solid #1e293b", display: "flex", padding: "0 20px", overflowX: "auto" }}>
        {TABS.map((t, i) => (
          <button key={i} onClick={() => setTab(i)} style={{
            padding: "12px 18px", fontSize: 13, background: "transparent", border: "none",
            borderBottom: tab === i ? "2px solid #f59e0b" : "2px solid transparent",
            color: tab === i ? "#fbbf24" : "#64748b",
            cursor: "pointer", fontFamily: "inherit", fontWeight: tab === i ? 600 : 400,
            whiteSpace: "nowrap", transition: "color 0.15s",
            display: "flex", alignItems: "center", gap: 6
          }}>
            <span style={{ fontSize: 14 }}>{t.icon}</span>{t.label}
          </button>
        ))}
      </div>

      {/* コンテンツ */}
      <div style={{ padding: "24px 28px", maxWidth: 1140, margin: "0 auto" }}>

        {/* Tab 0: 基本情報 */}
        {tab === 0 && r && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
            <Panel title="電力エリア・需要設定">
              <IG label="電力エリア">
                <Sel value={p.area} onChange={upd("area")} options={Object.keys(AREAS).map(k => [k, k])} />
              </IG>
              <IG label="施設タイプ（需要カーブ）">
                <Sel value={p.demandProfile} onChange={upd("demandProfile")} options={Object.entries(PROFILES).map(([k, v]) => [k, v.label])} />
              </IG>
              <IG label="契約電力" hint="現在の高圧契約電力または最大需要電力">
                <NI value={p.contractPower} onChange={upd("contractPower")} min={50} max={10000} step={50} unit="kW" />
              </IG>
              <IG label="力率" hint="進み力率85%超で基本料金が割引（0.2%/1%）。遅れの場合は割増">
                <NI value={p.powerFactor} onChange={upd("powerFactor")} min={70} max={100} unit="%" />
              </IG>
            </Panel>

            <Panel title="現在の電気料金内訳（推計）" accent>
              <div style={{ marginBottom: 12, padding: "8px 12px", background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.15)", borderRadius: 6, fontSize: 11, color: "#92400e" }}>
                エリア: {p.area} ／ 需要率: {(r.prof.lf * 100).toFixed(0)}%（{r.prof.label}）
              </div>
              {[
                { l: "基本料金", v: r.baseBasic, sub: `${r.a.br.toLocaleString()}円/kW×${p.contractPower}kW×12月` },
                { l: "電力量料金", v: r.baseEnergy, sub: `${r.a.er}円/kWh × ${fmtN(r.annualKwh)}kWh` },
                { l: "再エネ賦課金", v: r.baseRenew, sub: `${r.a.rr}円/kWh` },
                { l: "年間合計", v: r.baseCost, highlight: true },
              ].map(row => (
                <div key={row.l} style={{ padding: "9px 0", borderBottom: "1px solid #1e293b" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 13, color: row.highlight ? "#e2e8f0" : "#94a3b8", fontWeight: row.highlight ? 600 : 400 }}>{row.l}</span>
                    <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: row.highlight ? 18 : 14, color: row.highlight ? "#ef4444" : "#e2e8f0", fontWeight: row.highlight ? 700 : 400 }}>{fmtY(row.v)}</span>
                  </div>
                  {row.sub && <div style={{ fontSize: 11, color: "#475569", marginTop: 2 }}>{row.sub}</div>}
                </div>
              ))}
              <div style={{ marginTop: 14, padding: "10px 12px", background: "#1e293b", borderRadius: 6 }}>
                <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>年間消費電力量</div>
                <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 16, color: "#e2e8f0", fontWeight: 600 }}>{fmtN(r.annualKwh)} kWh</div>
              </div>
            </Panel>
          </div>
        )}

        {/* Tab 1: 太陽光・蓄電池 */}
        {tab === 1 && r && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
            <Panel title="太陽光発電システム">
              <IG label="システム容量（kWp）" hint="直流定格容量（パネル総容量）">
                <NI value={p.solarCapacity} onChange={upd("solarCapacity")} min={10} max={5000} step={10} unit="kWp" />
              </IG>
              <IG label="パフォーマンス比率" hint="温度損失・配線損失・パワコン損失等込み。一般的に70〜80%">
                <NI value={p.performanceRatio} onChange={upd("performanceRatio")} min={55} max={90} step={1} unit="%" />
              </IG>
              <IG label="経年劣化率" hint="一般的に年0.5〜1.0%（メーカー保証は0.7%以下が多い）">
                <NI value={p.solarDeg} onChange={upd("solarDeg")} min={0.1} max={2} step={0.1} unit="%/年" />
              </IG>
              <div style={{ padding: "14px", background: "#1e293b", borderRadius: 8, marginTop: 6 }}>
                <div style={{ fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 8 }}>初年度 発電量推計</div>
                <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 22, color: "#f59e0b", fontWeight: 700 }}>{fmtN(r.genY1)} kWh</div>
                <div style={{ display: "flex", gap: 16, marginTop: 6 }}>
                  <div style={{ fontSize: 12, color: "#10b981" }}>自家消費: {fmtN(r.totalSC1)} kWh</div>
                  <div style={{ fontSize: 12, color: "#3b82f6" }}>余剰売電: {fmtN(r.feedIn1)} kWh</div>
                </div>
                <div style={{ fontSize: 11, color: "#475569", marginTop: 4 }}>
                  峰日射時間 {r.a.psh}h/日（{p.area}）× {p.performanceRatio}%
                </div>
              </div>
            </Panel>

            <Panel title="蓄電池システム">
              <IG label="蓄電池の設置">
                <Toggle value={p.hasBattery} onChange={upd("hasBattery")} options={[["設置する", true], ["設置しない", false]]} />
              </IG>
              {p.hasBattery ? (
                <>
                  <IG label="蓄電池容量">
                    <NI value={p.batteryCapacity} onChange={upd("batteryCapacity")} min={10} max={5000} step={10} unit="kWh" />
                  </IG>
                  <IG label="充電効率" hint="リチウムイオンの場合95〜98%程度">
                    <NI value={p.chargeEff} onChange={upd("chargeEff")} min={75} max={99} step={1} unit="%" />
                  </IG>
                  <IG label="放電効率" hint="リチウムイオンの場合95〜98%程度">
                    <NI value={p.dischargeEff} onChange={upd("dischargeEff")} min={75} max={99} step={1} unit="%" />
                  </IG>
                  <IG label="年間劣化率" hint="リチウムイオンで1〜3%/年。10年後70〜80%残存が目安">
                    <NI value={p.batDeg} onChange={upd("batDeg")} min={0.5} max={5} step={0.5} unit="%/年" />
                  </IG>
                </>
              ) : (
                <div style={{ padding: "40px 20px", textAlign: "center", color: "#334155", fontSize: 13 }}>
                  蓄電池なしで計算します
                </div>
              )}
            </Panel>
          </div>
        )}

        {/* Tab 2: 料金・売電 */}
        {tab === 2 && r && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
            <Panel title="電気料金単価（エリア参照値）">
              <div style={{ marginBottom: 14, padding: "8px 12px", background: "#1e293b", borderRadius: 6, fontSize: 11, color: "#64748b" }}>
                以下は{p.area}エリアの参照値です。実際の請求書の単価を確認してください。
              </div>
              <IG label={`基本料金（${p.area}）`}>
                <NI value={r.a.br} readOnly unit="円/kW/月" />
              </IG>
              <IG label="電力量料金単価">
                <NI value={r.a.er} readOnly unit="円/kWh" />
              </IG>
              <IG label="再エネ賦課金（2024年度）">
                <NI value={r.a.rr} readOnly unit="円/kWh" />
              </IG>
              <div style={{ marginTop: 8, padding: "10px 12px", background: "rgba(59,130,246,0.06)", border: "1px solid rgba(59,130,246,0.15)", borderRadius: 6, fontSize: 11, color: "#64748b" }}>
                ※ 電気料金単価はエリアの標準的な高圧電力（2024年度）の参考値です。
                実際の契約はプランや需要電力により異なります。
              </div>
            </Panel>

            <Panel title="売電・FIT設定" accent>
              <IG label="売電方式">
                <Sel value={p.fitType} onChange={upd("fitType")} options={[
                  ["fit",  "FIT（固定価格買取制度）"],
                  ["fip",  "FIP（プレミアム付き買取）"],
                  ["self", "自家消費のみ（売電なし）"],
                ]} />
              </IG>
              {p.fitType !== "self" && (
                <IG label="売電単価" hint="2024年度 高圧50kW以上：約10円/kWh（250kW以上：約9.2円/kWh）">
                  <NI value={p.fitRate} onChange={upd("fitRate")} min={0} max={40} step={0.5} unit="円/kWh" />
                </IG>
              )}
              <IG label="系統連系費用" hint="電力会社への連系申請・工事費。規模により大きく異なる">
                <NI value={p.gridConnCost} onChange={upd("gridConnCost")} min={0} max={50000000} step={100000} unit="円" />
              </IG>
              <div style={{ marginTop: 16, padding: "14px", background: "#1e293b", borderRadius: 8 }}>
                <div style={{ fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 10 }}>初年度 収益内訳</div>
                {[
                  { l: "電力量料金削減",   v: r.eSave1,   c: "#10b981" },
                  { l: "再エネ賦課金削減", v: r.rSave1,   c: "#34d399" },
                  { l: "売電収入",         v: r.fitInc1,  c: "#3b82f6" },
                  { l: "保守費用（控除）", v: -r.maint1,  c: "#ef4444" },
                  { l: "年間純削減額",     v: r.annSavings1, c: "#fbbf24", bold: true },
                ].map(row => (
                  <div key={row.l} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid #0f172a" }}>
                    <span style={{ fontSize: 12, color: "#94a3b8", fontWeight: row.bold ? 600 : 400 }}>{row.l}</span>
                    <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, color: row.c, fontWeight: row.bold ? 700 : 400 }}>{fmtY(row.v)}</span>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
        )}

        {/* Tab 3: 財務設定 */}
        {tab === 3 && r && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
            <Panel title="設備費用・補助金">
              <IG label="太陽光設備費（工事費込み）" hint={`容量単価: 約${r.solarUnitCost.toFixed(1)}万円/kWp`}>
                <NI value={p.solarCost} onChange={upd("solarCost")} min={0} max={1e9} step={500000} unit="円" />
              </IG>
              {p.hasBattery && (
                <IG label="蓄電池設備費（工事費込み）">
                  <NI value={p.batCost} onChange={upd("batCost")} min={0} max={5e8} step={500000} unit="円" />
                </IG>
              )}
              <IG label="太陽光 保守・メンテ費" hint="遠隔監視・定期点検・除草等。規模に応じて年間数十〜数百万円">
                <NI value={p.solarMaint} onChange={upd("solarMaint")} min={0} max={1e7} step={50000} unit="円/年" />
              </IG>
              {p.hasBattery && (
                <IG label="蓄電池 保守・メンテ費" hint="BMS点検・電解液補充等">
                  <NI value={p.batMaint} onChange={upd("batMaint")} min={0} max={1e7} step={50000} unit="円/年" />
                </IG>
              )}
              <IG label="補助金・助成金" hint="国・自治体補助金。実質初期投資から控除">
                <NI value={p.subsidyAmount} onChange={upd("subsidyAmount")} min={0} max={1e8} step={100000} unit="円" />
              </IG>
              <IG label="減価償却期間" hint="太陽光:17年（定率法9年）、蓄電池:6年（税務上の耐用年数）">
                <NI value={p.depreciation} onChange={upd("depreciation")} min={1} max={30} unit="年" />
              </IG>
            </Panel>

            <Panel title="財務・投資分析パラメータ" accent>
              <IG label="資金調達方法">
                <Toggle value={p.financingType} onChange={upd("financingType")} options={[["一括払い", "cash"], ["借入（ローン）", "loan"]]} />
              </IG>
              {p.financingType === "loan" && (
                <>
                  <IG label="借入金利">
                    <NI value={p.loanRate} onChange={upd("loanRate")} min={0.1} max={10} step={0.1} unit="%" />
                  </IG>
                  <IG label="返済期間">
                    <NI value={p.loanYears} onChange={upd("loanYears")} min={1} max={20} unit="年" />
                  </IG>
                </>
              )}
              <IG label="割引率（NPV計算用）" hint="企業の加重平均資本コスト（WACC）。一般的に3〜8%">
                <NI value={p.discountRate} onChange={upd("discountRate")} min={0} max={20} step={0.5} unit="%" />
              </IG>
              <IG label="電気料金上昇率" hint="将来の電気料金上昇の仮定。過去10年平均は約2〜3%/年">
                <NI value={p.elecEsc} onChange={upd("elecEsc")} min={0} max={10} step={0.5} unit="%/年" />
              </IG>
              <IG label="分析期間">
                <NI value={p.analysisYears} onChange={upd("analysisYears")} min={5} max={30} unit="年" />
              </IG>
              <div style={{ marginTop: 16, padding: "14px", background: "#1e293b", borderRadius: 8 }}>
                {[
                  { l: "実質初期投資", v: fmtY(r.initInv), c: "#f59e0b" },
                  { l: "年間減価償却費", v: fmtY(r.annDep), c: "#94a3b8" },
                  ...(p.financingType === "loan" ? [{ l: `年間ローン返済額（${p.loanYears}年）`, v: fmtY(r.annLoan), c: "#64748b" }] : []),
                ].map(row => (
                  <div key={row.l} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid #0f172a" }}>
                    <span style={{ fontSize: 12, color: "#94a3b8" }}>{row.l}</span>
                    <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, color: row.c, fontWeight: 600 }}>{row.v}</span>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
        )}

        {/* Tab 4: シミュレーション結果 */}
        {tab === 4 && r && (
          <div>
            {/* KPI カード */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 24 }}>
              <KpiCard icon="⏱" label="単純回収年数"
                value={r.paybackYear ? `${r.paybackYear}年` : "未回収"}
                sub={`初期投資 ${fmtY(r.initInv)}`}
                color={r.paybackYear ? "#fbbf24" : "#ef4444"}
                warn={!r.paybackYear}
              />
              <KpiCard icon="💹" label={`NPV（割引率${p.discountRate}%）`}
                value={fmtY(r.npv)}
                sub={`${p.analysisYears}年間分析`}
                color={r.npv >= 0 ? "#10b981" : "#ef4444"}
                warn={r.npv < 0}
              />
              <KpiCard icon="📈" label="IRR（内部収益率）"
                value={r.irr !== null ? `${r.irr.toFixed(2)}%` : "算出不可"}
                sub={`資本コスト ${p.discountRate}% ${r.irr !== null ? (r.irr > p.discountRate ? "✓ 上回る" : "✗ 下回る") : ""}`}
                color={r.irr !== null ? (r.irr > p.discountRate ? "#10b981" : "#ef4444") : "#64748b"}
              />
              <KpiCard icon="🌱" label="CO₂削減量（初年度）"
                value={`${r.co2.toFixed(1)} t`}
                sub={`${(r.co2 * p.analysisYears).toFixed(0)}t（${p.analysisYears}年累計）`}
                color="#34d399"
              />
            </div>

            {/* チャート 2列 */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
              {/* 累積CF */}
              <Panel title="累積キャッシュフロー推移（万円）">
                <ResponsiveContainer width="100%" height={230}>
                  <ComposedChart data={r.years} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="year" tick={{ fill: "#475569", fontSize: 11 }} />
                    <YAxis tick={{ fill: "#475569", fontSize: 11 }} />
                    <Tooltip content={<TT />} />
                    <ReferenceLine y={0} stroke="#475569" strokeDasharray="4 4" />
                    {r.paybackYear && (
                      <ReferenceLine x={r.paybackYear} stroke="#f59e0b" strokeDasharray="3 3"
                        label={{ value: `${r.paybackYear}年（回収）`, fill: "#f59e0b", fontSize: 10, position: "top" }} />
                    )}
                    <Bar dataKey="annCF" fill="#3b82f6" opacity={0.5} name="年間CF" />
                    <Line type="monotone" dataKey="cumCF" stroke="#f59e0b" strokeWidth={2} dot={false} name="累積CF" />
                  </ComposedChart>
                </ResponsiveContainer>
              </Panel>

              {/* 電気料金比較 */}
              <Panel title="電気料金比較推移（万円/年）">
                <ResponsiveContainer width="100%" height={230}>
                  <LineChart data={r.years} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="year" tick={{ fill: "#475569", fontSize: 11 }} />
                    <YAxis tick={{ fill: "#475569", fontSize: 11 }} />
                    <Tooltip content={<TT />} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="baseEsc" stroke="#ef4444" strokeWidth={2} dot={false} name="現状電気料金" />
                    <Line type="monotone" dataKey="afterEsc" stroke="#10b981" strokeWidth={2} dot={false} name="導入後実質コスト" />
                  </LineChart>
                </ResponsiveContainer>
              </Panel>
            </div>

            {/* 発電推移 */}
            <Panel title="年間発電・自家消費・売電推移（kWh）">
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={r.years} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="year" tick={{ fill: "#475569", fontSize: 11 }} />
                  <YAxis tick={{ fill: "#475569", fontSize: 11 }} />
                  <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 6, fontSize: 12 }} labelFormatter={v => `${v}年目`} formatter={(v, n) => [`${v.toLocaleString()} kWh`, n]} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="tsc" fill="#f59e0b" name="自家消費" stackId="a" />
                  <Bar dataKey="fi"  fill="#3b82f6" name="余剰売電" stackId="a" />
                </BarChart>
              </ResponsiveContainer>
            </Panel>

            {/* 年次詳細テーブル */}
            <div style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 12, padding: "20px", marginTop: 20 }}>
              <h3 style={{ margin: "0 0 14px", fontSize: 11, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "1px" }}>年次詳細データ</h3>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: "2px solid #334155" }}>
                      {["年", "発電量(kWh)", "自家消費(kWh)", "売電(kWh)", "年間削減(万円)", "減価償却(万円)", "累積CF(万円)"].map(h => (
                        <th key={h} style={{ padding: "6px 10px", textAlign: "right", color: "#64748b", fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.3px" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {r.years.map(y => {
                      const isPayback = y.year === r.paybackYear;
                      return (
                        <tr key={y.year} style={{ borderBottom: "1px solid #1a2332", background: isPayback ? "rgba(245,158,11,0.06)" : "transparent" }}>
                          <td style={{ padding: "5px 10px", textAlign: "right", fontFamily: "'IBM Plex Mono',monospace", color: isPayback ? "#fbbf24" : "#64748b" }}>
                            {y.year}{isPayback ? " ★" : ""}
                          </td>
                          <td style={{ padding: "5px 10px", textAlign: "right", fontFamily: "'IBM Plex Mono',monospace", color: "#e2e8f0" }}>{y.gen.toLocaleString()}</td>
                          <td style={{ padding: "5px 10px", textAlign: "right", fontFamily: "'IBM Plex Mono',monospace", color: "#f59e0b" }}>{y.tsc.toLocaleString()}</td>
                          <td style={{ padding: "5px 10px", textAlign: "right", fontFamily: "'IBM Plex Mono',monospace", color: "#3b82f6" }}>{y.fi.toLocaleString()}</td>
                          <td style={{ padding: "5px 10px", textAlign: "right", fontFamily: "'IBM Plex Mono',monospace", color: "#10b981" }}>{y.annCF.toLocaleString()}</td>
                          <td style={{ padding: "5px 10px", textAlign: "right", fontFamily: "'IBM Plex Mono',monospace", color: "#64748b" }}>{y.dep.toLocaleString()}</td>
                          <td style={{ padding: "5px 10px", textAlign: "right", fontFamily: "'IBM Plex Mono',monospace", color: y.cumCF >= 0 ? "#10b981" : "#ef4444", fontWeight: y.cumCF >= 0 ? 700 : 400 }}>{y.cumCF.toLocaleString()}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 免責事項 */}
            <div style={{ marginTop: 16, padding: "10px 14px", background: "#0d1523", border: "1px solid #1e293b", borderRadius: 6, fontSize: 11, color: "#475569", lineHeight: 1.6 }}>
              ⚠ 本ツールの計算結果はあくまで参考値です。実際の効果は気象条件・施工状況・電力会社のプラン・税務処理等により異なります。
              投資判断の際は専門家（電気工事業者・税理士・電力会社）にご相談ください。
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
