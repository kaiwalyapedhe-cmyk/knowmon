import { NavLink, Outlet } from "react-router-dom";
import { UserButton } from "@clerk/react";
import { BarChart3, BookOpen, GitBranch, GraduationCap, Headphones, ClipboardCheck, Users, MessageSquareHeart, Globe } from "lucide-react";
import { useMe, ROLE_LABELS } from "@/context/MeContext";

const NAV = [
  { group: "Quality", items: [
    { to: "/dashboard", label: "Dashboard", icon: BarChart3 },
    { to: "/interactions", label: "Interactions", icon: Headphones },
    { to: "/qa-forms", label: "QA Forms", icon: ClipboardCheck, qa: true },
    { to: "/coaching", label: "Coaching", icon: MessageSquareHeart },
  ]},
  { group: "Knowledge", items: [
    { to: "/knowledge", label: "Knowledge Hub", icon: BookOpen },
    { to: "/trees", label: "Decision Trees", icon: GitBranch },
    { to: "/training", label: "Training", icon: GraduationCap },
  ]},
  { group: "Admin", admin: true, items: [{ to: "/users", label: "Users & Roles", icon: Users }] },
];

function NavItem({ item }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      data-testid={`nav-${item.to.slice(1)}`}
      className={({ isActive }) =>
        `flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${isActive ? "bg-blue-500/15 text-blue-300" : "text-slate-400 hover:bg-white/5 hover:text-white"}`}
    >
      <Icon className="h-4 w-4" /> {item.label}
    </NavLink>
  );
}

export default function Layout() {
  const { me, isQA, isAdmin } = useMe();
  const groups = NAV.filter((g) => !g.admin || isAdmin).map((g) => ({ ...g, items: g.items.filter((i) => !i.qa || isQA) }));
  return (
    <div className="flex min-h-screen bg-[#0B0E14]">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-white/5 bg-[#0E121A] p-4 lg:flex">
        <div className="mb-8 px-2">
          <div className="font-display text-xl font-extrabold tracking-tight">Cadence<span className="text-blue-400">CX</span></div>
          <div className="label-mono mt-1">Quality × Knowledge</div>
        </div>
        <nav className="flex-1 space-y-6">
          {groups.map((g) => (
            <div key={g.group}>
              <div className="label-mono mb-2 px-3">{g.group}</div>
              <div className="space-y-1">{g.items.map((i) => <NavItem key={i.to} item={i} />)}</div>
            </div>
          ))}
        </nav>
        <a href="/help" target="_blank" rel="noreferrer" data-testid="nav-self-service" className="flex items-center gap-2 px-3 py-2 text-xs text-slate-500 hover:text-white">
          <Globe className="h-3.5 w-3.5" /> Customer self-service portal
        </a>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between gap-4 border-b border-white/5 bg-[#0B0E14]/80 px-4 py-3 backdrop-blur-xl sm:px-8">
          <div className="font-display text-lg font-extrabold lg:hidden">Cadence<span className="text-blue-400">CX</span></div>
          <div className="hidden text-sm text-slate-400 lg:block">Welcome back, <span className="text-white" data-testid="header-user-name">{me.name}</span></div>
          <div className="flex items-center gap-3">
            <span data-testid="header-role-badge" className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-blue-300">{ROLE_LABELS[me.role]}</span>
            <UserButton />
          </div>
        </header>
        <nav className="flex gap-1 overflow-x-auto border-b border-white/5 px-3 py-2 lg:hidden">
          {groups.flatMap((g) => g.items).map((i) => <NavItem key={i.to} item={i} />)}
        </nav>
        <main className="flex-1 px-4 py-8 sm:px-8 lg:px-10"><Outlet /></main>
      </div>
    </div>
  );
}
