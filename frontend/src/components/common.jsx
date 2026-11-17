import { Mail, MessageSquare, Phone, Store, MessageCircle } from "lucide-react";

export const CHANNELS = [
  { value: "voice", label: "Voice call", icon: Phone },
  { value: "email", label: "Email", icon: Mail },
  { value: "chat", label: "Chat", icon: MessageSquare },
  { value: "whatsapp", label: "WhatsApp", icon: MessageCircle },
  { value: "in_store", label: "In-store", icon: Store },
];

export function ChannelTag({ channel }) {
  const c = CHANNELS.find((x) => x.value === channel) || CHANNELS[0];
  const Icon = c.icon;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-300">
      <Icon className="h-3.5 w-3.5 text-cyan-400" /> {c.label}
    </span>
  );
}

export const scoreColor = (s) => (s >= 85 ? "text-emerald-400" : s >= 70 ? "text-amber-400" : "text-rose-400");

export function ScoreBadge({ score, autoFailed, testId }) {
  if (autoFailed) return <span data-testid={testId} className="rounded bg-rose-500/15 px-2 py-0.5 font-mono text-xs text-rose-400">AUTO-FAIL</span>;
  return <span data-testid={testId} className={`font-mono text-sm font-semibold ${scoreColor(score)}`}>{Number(score).toFixed(1)}%</span>;
}

export function PageHeader({ eyebrow, title, desc, children }) {
  return (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between fade-up">
      <div>
        {eyebrow && <div className="label-mono mb-2">{eyebrow}</div>}
        <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl" data-testid="page-title">{title}</h1>
        {desc && <p className="mt-2 max-w-2xl text-sm text-slate-400">{desc}</p>}
      </div>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

export function Empty({ text, testId }) {
  return <div data-testid={testId} className="card-surface p-10 text-center text-sm text-slate-400">{text}</div>;
}

export function NativeSelect({ value, onChange, options, testId, className = "" }) {
  return (
    <select
      data-testid={testId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`h-9 w-full rounded-md border border-input bg-[#0B0E14] px-3 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 ${className}`}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Field({ label, children }) {
  return (
    <label className="block space-y-1.5">
      <span className="label-mono">{label}</span>
      {children}
    </label>
  );
}

export const fmtDate = (s) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");
