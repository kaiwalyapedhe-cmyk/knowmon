export function StepGuide({ steps }) {
  if (!steps?.length) return null;
  return (
    <div className="space-y-4" data-testid="article-steps">
      <div className="label-mono">Step-by-step guide</div>
      {steps.map((s, i) => (
        <div key={i} className="card-surface flex flex-col gap-4 p-5 sm:flex-row" data-testid={`article-step-${i}`}>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-500/15 font-mono text-sm text-blue-300">{i + 1}</div>
          <div className="flex-1">
            <h4 className="font-semibold">{s.title}</h4>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-300">{s.body}</p>
            {s.image_url && <img src={s.image_url} alt={s.title} className="mt-3 max-h-72 rounded-md border border-white/10 object-cover" />}
          </div>
        </div>
      ))}
    </div>
  );
}
