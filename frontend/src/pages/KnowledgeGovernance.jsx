import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ShieldCheck, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useApi, errMsg } from "@/lib/api";
import { useMe } from "@/context/MeContext";
import { Empty, PageHeader, fmtDate } from "@/components/common";

const STATUS_STYLE = { draft: "bg-slate-100 text-slate-600", in_review: "bg-amber-100 text-amber-700", approved: "bg-[#1B3F94]/10 text-[#1B3F94]", published: "bg-emerald-100 text-emerald-700", archived: "bg-rose-50 text-rose-600" };

function Kpi({ label, value, note, tone }) {
  return (
    <div className="card-surface p-5">
      <div className="label-mono">{label}</div>
      <div className={`mt-2 text-3xl font-extrabold tracking-tight ${tone || ""}`}>{value}</div>
      {note && <div className="mt-1 text-xs text-slate-500">{note}</div>}
    </div>
  );
}

function ArticleTable({ rows, empty, actions }) {
  if (!rows.length) return <Empty text={empty} />;
  return (
    <table className="w-full text-sm">
      <thead><tr className="label-mono text-left"><th className="py-2">Article</th><th className="py-2">Owner</th><th className="py-2">Date</th><th className="py-2 text-right">{actions ? "Action" : ""}</th></tr></thead>
      <tbody>
        {rows.map((a) => (
          <tr key={a.id} className="border-t border-slate-200">
            <td className="py-2"><Link to={`/knowledge/${a.id}`} className="text-[#1B3F94] hover:underline">{a.title}</Link></td>
            <td className="py-2 text-xs text-slate-500">{a.owner_name || "—"}</td>
            <td className="py-2 text-xs text-slate-500">{fmtDate(a.review_date || a.expires_at || a.updated_at)}</td>
            <td className="py-2 text-right">{actions?.(a)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function KnowledgeGovernance() {
  const api = useApi();
  const { isQA } = useMe();
  const [data, setData] = useState(null);

  const load = useCallback(() => {
    api.get("/kb/governance").then((r) => setData(r.data)).catch((e) => toast.error(errMsg(e)));
  }, [api]);
  useEffect(() => { load(); }, [load]);

  const act = async (a, action) => {
    try {
      await api.post(`/kb/articles/${a.id}/${action}`, {});
      toast.success(`Article ${action === "approve" ? "approved" : "published"}`);
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };
  const approveAndPublish = async (a) => {
    try {
      await api.post(`/kb/articles/${a.id}/approve`, {});
      await api.post(`/kb/articles/${a.id}/publish`, {});
      toast.success("Article approved and published");
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  if (!data) return <div className="label-mono">Loading…</div>;
  return (
    <div>
      <PageHeader eyebrow="Knowledge governance" title="Lifecycle & quality" desc="Articles move from draft to review, approval and publication. Keep owners, review dates and feedback under control." />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Kpi label="Published" value={data.counts.published} note={`${data.totals.articles} total articles`} />
        <Kpi label="In review" value={data.counts.in_review} note="Awaiting approval" tone={data.counts.in_review ? "text-amber-600" : ""} />
        <Kpi label="Drafts" value={data.counts.drafts} note={`${data.counts.approved} approved`} />
        <Kpi label="Review overdue" value={data.overdue_review.length} note="Past the next review date" tone={data.overdue_review.length ? "text-red-600" : ""} />
        <Kpi label="Expiring soon" value={data.expiring.length} note="Expire within 30 days" tone={data.expiring.length ? "text-amber-600" : ""} />
      </div>

      <div className="mt-6 space-y-6">
        <section className="card-surface p-6">
          <div className="label-mono mb-4 flex items-center gap-2"><ShieldCheck className="h-3.5 w-3.5" />Approval queue</div>
          <ArticleTable rows={data.awaiting_approval} empty="Nothing is waiting for approval." actions={(a) => (
            <span className="flex justify-end gap-1">
              {isQA && <Button size="sm" variant="outline" className="hover:text-[#1B3F94]" onClick={() => act(a, "approve")} data-testid={`approve-${a.id}`}>Approve</Button>}
              {isQA && <Button size="sm" onClick={() => approveAndPublish(a)} data-testid={`approve-publish-${a.id}`}>Approve &amp; publish</Button>}
            </span>
          )} />
        </section>

        <section className="card-surface p-6">
          <div className="label-mono mb-4 flex items-center gap-2"><ShieldCheck className="h-3.5 w-3.5" />Approved · ready to publish</div>
          <ArticleTable rows={data.ready_to_publish} empty="Nothing has been approved yet." actions={(a) => (
            isQA ? <Button size="sm" onClick={() => act(a, "publish")} data-testid={`publish-${a.id}`}>Publish</Button> : null
          )} />
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="card-surface p-6">
            <div className="label-mono mb-4 flex items-center gap-2"><AlertTriangle className="h-3.5 w-3.5 text-amber-600" />Review dates passed</div>
            <ArticleTable rows={data.overdue_review} empty="No article is past its review date." />
          </section>
          <section className="card-surface p-6">
            <div className="label-mono mb-4 flex items-center gap-2"><AlertTriangle className="h-3.5 w-3.5 text-amber-600" />Expiring within 30 days</div>
            <ArticleTable rows={data.expiring} empty="No article expires in the next 30 days." />
          </section>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="card-surface p-6">
            <div className="label-mono mb-4">Article feedback</div>
            {data.feedback.length === 0 ? <Empty text="No feedback yet. Agents rate articles on the article page." /> : (
              <table className="w-full text-sm">
                <thead><tr className="label-mono text-left"><th className="py-2">Article</th><th className="py-2 text-right">Helpful</th><th className="py-2 text-right">Not helpful</th><th className="py-2 text-right">Rate</th></tr></thead>
                <tbody>
                  {data.feedback.map((f) => (
                    <tr key={f.id} className="border-t border-slate-200">
                      <td className="py-2"><Link to={`/knowledge/${f.id}`} className="text-[#1B3F94] hover:underline">{f.title}</Link></td>
                      <td className="py-2 text-right font-mono text-xs text-emerald-600">{f.helpful_count}</td>
                      <td className="py-2 text-right font-mono text-xs text-red-600">{f.not_helpful_count}</td>
                      <td className="py-2 text-right font-mono text-xs">{f.helpful_rate}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section className="card-surface p-6">
            <div className="label-mono mb-4">Least used published articles</div>
            {data.stale.length === 0 ? <Empty text="No published articles yet." /> : (
              <table className="w-full text-sm">
                <thead><tr className="label-mono text-left"><th className="py-2">Article</th><th className="py-2 text-right">Views</th></tr></thead>
                <tbody>
                  {data.stale.map((a) => (
                    <tr key={a.id} className="border-t border-slate-200">
                      <td className="py-2"><Link to={`/knowledge/${a.id}`} className="text-[#1B3F94] hover:underline">{a.title}</Link></td>
                      <td className="py-2 text-right font-mono text-xs">{a.views}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>

        <section className="card-surface p-6">
          <div className="label-mono mb-4">Recent governance activity</div>
          {data.recent_audit.length === 0 ? <Empty text="No lifecycle changes recorded yet." /> : (
            <ul className="space-y-2 text-sm">
              {data.recent_audit.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-2 first:border-0 first:pt-0">
                  <span><span className="font-mono text-[10px] uppercase text-[#E31E24]">{e.action}</span> · <Link to={`/knowledge/${e.article_id}`} className="text-[#1B3F94] hover:underline">{e.article_id?.slice(0, 8)}</Link> {e.note && <span className="text-slate-500">— {e.note}</span>}</span>
                  <span className="text-xs text-slate-500">{e.by_name || "—"} · {fmtDate(e.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
