import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useApi, errMsg } from "@/lib/api";
import { useMe, ROLE_LABELS } from "@/context/MeContext";
import { NativeSelect, PageHeader, fmtDate } from "@/components/common";

export default function Users() {
  const api = useApi();
  const { me, isAdmin } = useMe();
  const [data, setData] = useState(null);
  const load = useCallback(() => api.get("/users").then((r) => setData(r.data)), [api]);
  useEffect(() => { if (isAdmin) load(); }, [load, isAdmin]);
  const change = async (uid, role) => {
    try { await api.patch(`/users/${uid}/role`, { role }); toast.success("Role updated"); load(); }
    catch (e) { toast.error(errMsg(e)); }
  };
  if (!isAdmin) return <p className="text-slate-500">Admins only.</p>;
  if (!data) return <div className="label-mono">Loading…</div>;
  return (
    <div>
      <PageHeader eyebrow="Access control" title="Users & Roles" desc="Admins manage everything · QA Auditors own QA forms and scoring · Team Leads coach and author content · Agents see their own scores, coaching and training." />
      <div className="card-surface overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm" data-testid="users-table">
          <thead><tr className="label-mono text-left"><th className="p-4">Name</th><th className="p-4">Email</th><th className="p-4">Joined</th><th className="p-4">Role</th></tr></thead>
          <tbody>
            {data.users.map((u) => (
              <tr key={u.user_id} className="border-t border-slate-200" data-testid={`user-row-${u.user_id}`}>
                <td className="p-4 font-medium">{u.name}{u.user_id === me.user_id && <span className="ml-2 text-xs text-slate-500">(you)</span>}</td>
                <td className="p-4 text-slate-500">{u.email}</td>
                <td className="p-4 text-xs text-slate-500">{fmtDate(u.created_at)}</td>
                <td className="w-48 p-4"><NativeSelect testId={`role-select-${u.user_id}`} value={u.role} onChange={(r) => change(u.user_id, r)} options={data.roles.map((r) => ({ value: r, label: ROLE_LABELS[r] || r }))} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
