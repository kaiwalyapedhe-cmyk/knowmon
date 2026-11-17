import { createContext, useContext, useEffect, useState } from "react";
import { useApi, errMsg } from "@/lib/api";

const MeContext = createContext(null);
const STAFF = ["admin", "qa_auditor", "team_lead"];

export function MeProvider({ children }) {
  const api = useApi();
  const [me, setMe] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.get("/me").then((r) => setMe(r.data)).catch((e) => setError(errMsg(e)));
  }, [api]);
  if (error) return <p className="p-8 text-rose-400" data-testid="me-error">{error}</p>;
  if (!me) return <div className="p-8 label-mono" data-testid="me-loading">Loading workspace…</div>;
  const value = {
    me,
    isStaff: STAFF.includes(me.role),
    isQA: ["admin", "qa_auditor"].includes(me.role),
    isAdmin: me.role === "admin",
  };
  return <MeContext.Provider value={value}>{children}</MeContext.Provider>;
}

export const useMe = () => useContext(MeContext);
export const ROLE_LABELS = { admin: "Admin", qa_auditor: "QA Auditor", team_lead: "Team Lead", agent: "Agent" };
