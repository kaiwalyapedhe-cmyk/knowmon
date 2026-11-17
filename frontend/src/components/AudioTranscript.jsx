import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useApi } from "@/lib/api";

const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

export const AudioTranscript = forwardRef(function AudioTranscript({ interaction }, ref) {
  const api = useApi();
  const audio = useRef(null);
  const [src, setSrc] = useState("");
  const [err, setErr] = useState("");
  const [now, setNow] = useState(0);
  const [started, setStarted] = useState(false);
  const segs = interaction.segments || [];

  useEffect(() => {
    if (!interaction.audio_path) return;
    let url = "", cancelled = false;
    api.get(`/interactions/${interaction.id}/audio`, { responseType: "blob" })
      .then((r) => { if (cancelled) return; url = URL.createObjectURL(r.data); setSrc(url); })
      .catch(() => { if (!cancelled) setErr("Recording is unavailable right now."); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [api, interaction.id, interaction.audio_path]);

  const seek = (t) => { if (audio.current) { audio.current.currentTime = t; audio.current.play()?.catch(() => {}); } };
  useImperativeHandle(ref, () => ({
    getTime: () => audio.current?.currentTime || 0,
    seek,
    seekToQuote: (quote) => {
      const words = (quote || "").toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter((w) => w.length > 2);
      let best = null, bestHits = 0;
      segs.forEach((s) => { const t = s.text.toLowerCase(); const hits = words.filter((w) => t.includes(w)).length; if (hits > bestHits) { best = s; bestHits = hits; } });
      if (best) seek(best.start);
    },
  }));

  return (
    <div className="card-surface p-6" data-testid="call-playback">
      <div className="label-mono mb-3">{interaction.audio_path ? `Call recording · ${interaction.audio_name}` : "Conversation"}</div>
      {interaction.audio_path && (
        src ? <audio ref={audio} src={src} controls className="w-full" onPlay={() => setStarted(true)} onTimeUpdate={(e) => setNow(e.target.currentTime)} data-testid="audio-player" />
          : err ? <p className="text-sm text-red-600">{err}</p> : <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Loading recording…</div>
      )}
      {segs.length > 0 ? (
        <div className="mt-4 max-h-96 space-y-1 overflow-y-auto pr-2" data-testid="transcript-segments">
          {segs.map((s, i) => {
            const active = started && now >= s.start && now < s.end;
            return (
              <button key={i} onClick={() => seek(s.start)} data-testid={`transcript-segment-${i}`}
                className={`flex w-full gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${active ? "bg-[#1B3F94]/10 text-[#16357F]" : "text-slate-600 hover:bg-slate-100"}`}>
                <span className="w-10 shrink-0 font-mono text-xs text-[#E31E24]">{fmt(s.start)}</span><span>{s.text}</span>
              </button>
            );
          })}
        </div>
      ) : interaction.transcript && (
        <pre className="mt-4 max-h-96 overflow-y-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-slate-600" data-testid="interaction-transcript">{interaction.transcript}</pre>
      )}
    </div>
  );
});
