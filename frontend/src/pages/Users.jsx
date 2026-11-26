import { useCallback, useEffect, useMemo, useState } from "react";
import { 
  UserPlus, KeyRound, ShieldAlert, CheckCircle2, XCircle, Search, 
  Trash2, UserCheck, UserX, Copy, RefreshCw, Eye, EyeOff, Loader2,
  Users as UsersIcon, Shield, Headphones, Award
} from "lucide-react";
import { toast } from "sonner";
import { useApi, errMsg } from "@/lib/api";
import { useMe, ROLE_LABELS } from "@/context/MeContext";
import { NativeSelect, PageHeader, fmtDate } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

function generateSecurePassword() {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*";
  let pwd = "";
  for (let i = 0; i < 12; i++) {
    pwd += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pwd;
}

export default function Users() {
  const api = useApi();
  const { me, isAdmin } = useMe();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  // Search & Filter
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");

  // Modals state
  const [addOpen, setAddOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  // Add User Form State
  const [newUserData, setNewUserData] = useState({
    name: "",
    email: "",
    username: "",
    role: "agent",
    password: "",
  });
  const [showAddPw, setShowAddPw] = useState(false);
  const [addingUser, setAddingUser] = useState(false);

  // Reset Password State
  const [newPassword, setNewPassword] = useState("");
  const [showResetPw, setShowResetPw] = useState(false);
  const [resettingPw, setResettingPw] = useState(false);

  // Delete State
  const [deletingUser, setDeletingUser] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get("/users");
      setData(res.data);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (isAdmin) load();
  }, [load, isAdmin]);

  // Handle Role Change
  const changeRole = async (uid, role) => {
    try {
      await api.patch(`/users/${uid}/role`, { role });
      toast.success("Role updated successfully");
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  // Handle Toggle Active/Disabled Status
  const toggleStatus = async (user) => {
    const nextDisabled = !user.disabled;
    try {
      await api.patch(`/users/${user.user_id}/status`, { disabled: nextDisabled });
      toast.success(nextDisabled ? `User ${user.name} deactivated` : `User ${user.name} activated`);
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  // Handle Create User Submit
  const handleCreateUser = async (e) => {
    e.preventDefault();
    if (!newUserData.name.trim() || !newUserData.email.trim()) {
      toast.error("Please provide both name and email.");
      return;
    }
    setAddingUser(true);
    try {
      await api.post("/users", newUserData);
      toast.success(`User ${newUserData.name} created successfully!`);
      setAddOpen(false);
      setNewUserData({ name: "", email: "", username: "", role: "agent", password: "" });
      load();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setAddingUser(false);
    }
  };

  // Handle Password Reset Submit
  const handleResetPassword = async (e) => {
    e.preventDefault();
    if (!newPassword || newPassword.length < 4) {
      toast.error("Password must be at least 4 characters long.");
      return;
    }
    setResettingPw(true);
    try {
      await api.post(`/users/${resetTarget.user_id}/reset-password`, { new_password: newPassword });
      toast.success(`Password for ${resetTarget.name} has been reset!`);
      setResetTarget(null);
      setNewPassword("");
      load();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setResettingPw(false);
    }
  };

  // Handle Delete User Submit
  const handleDeleteUser = async () => {
    if (!deleteTarget) return;
    setDeletingUser(true);
    try {
      await api.delete(`/users/${deleteTarget.user_id}`);
      toast.success(`User ${deleteTarget.name} deleted.`);
      setDeleteTarget(null);
      load();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setDeletingUser(false);
    }
  };

  // Filtered Users
  const filteredUsers = useMemo(() => {
    if (!data?.users) return [];
    return data.users.filter((u) => {
      const matchQuery = 
        u.name?.toLowerCase().includes(query.toLowerCase()) ||
        u.email?.toLowerCase().includes(query.toLowerCase()) ||
        u.username?.toLowerCase().includes(query.toLowerCase());
      const matchRole = roleFilter === "all" || u.role === roleFilter;
      return matchQuery && matchRole;
    });
  }, [data, query, roleFilter]);

  // Statistics
  const stats = useMemo(() => {
    if (!data?.users) return { total: 0, admin: 0, qa: 0, leads: 0, agents: 0 };
    return {
      total: data.users.length,
      admin: data.users.filter((u) => u.role === "admin").length,
      qa: data.users.filter((u) => u.role === "qa_auditor").length,
      leads: data.users.filter((u) => u.role === "team_lead").length,
      agents: data.users.filter((u) => u.role === "agent").length,
    };
  }, [data]);

  if (!isAdmin) return <p className="text-slate-500 p-8">Administrators only.</p>;
  if (loading && !data) return <div className="p-8 label-mono">Loading user directory…</div>;

  return (
    <div className="space-y-6">
      <PageHeader 
        eyebrow="Access Control" 
        title="Users & Roles" 
        desc="Manage accounts, assign roles, configure authentication credentials, and perform password resets."
      >
        <Button 
          data-testid="add-user-btn"
          onClick={() => {
            setNewUserData({ name: "", email: "", username: "", role: "agent", password: generateSecurePassword() });
            setAddOpen(true);
          }}
          className="gap-2 bg-[#1B3F94] hover:bg-[#14306F] text-white"
        >
          <UserPlus className="h-4 w-4" /> Add User
        </Button>
      </PageHeader>

      {/* Metrics Row */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="card-surface flex items-center gap-3 p-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-[#1B3F94]">
            <UsersIcon className="h-5 w-5" />
          </div>
          <div>
            <div className="text-2xl font-extrabold text-slate-900">{stats.total}</div>
            <div className="text-xs font-medium text-slate-500">Total Users</div>
          </div>
        </div>
        <div className="card-surface flex items-center gap-3 p-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-50 text-[#E31E24]">
            <Shield className="h-5 w-5" />
          </div>
          <div>
            <div className="text-2xl font-extrabold text-slate-900">{stats.admin}</div>
            <div className="text-xs font-medium text-slate-500">Administrators</div>
          </div>
        </div>
        <div className="card-surface flex items-center gap-3 p-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
            <Award className="h-5 w-5" />
          </div>
          <div>
            <div className="text-2xl font-extrabold text-slate-900">{stats.qa + stats.leads}</div>
            <div className="text-xs font-medium text-slate-500">QA & Team Leads</div>
          </div>
        </div>
        <div className="card-surface flex items-center gap-3 p-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
            <Headphones className="h-5 w-5" />
          </div>
          <div>
            <div className="text-2xl font-extrabold text-slate-900">{stats.agents}</div>
            <div className="text-xs font-medium text-slate-500">Agents</div>
          </div>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input 
            type="text" 
            placeholder="Search by name, email, or username…" 
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9 bg-white"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-500">Filter Role:</span>
          <NativeSelect 
            value={roleFilter} 
            onChange={setRoleFilter}
            options={[
              { value: "all", label: "All Roles" },
              ...(data?.roles || []).map((r) => ({ value: r, label: ROLE_LABELS[r] || r }))
            ]}
            className="w-40 bg-white"
          />
        </div>
      </div>

      {/* Users Table */}
      <div className="card-surface overflow-x-auto shadow-sm">
        <table className="w-full min-w-[700px] text-sm" data-testid="users-table">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/75 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
              <th className="p-4">User</th>
              <th className="p-4">Email</th>
              <th className="p-4">Role</th>
              <th className="p-4">Authentication</th>
              <th className="p-4">Status</th>
              <th className="p-4">Joined</th>
              <th className="p-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {filteredUsers.length === 0 ? (
              <tr>
                <td colSpan={7} className="p-8 text-center text-slate-500">
                  No users found matching your criteria.
                </td>
              </tr>
            ) : (
              filteredUsers.map((u) => {
                const isSelf = u.user_id === me.user_id;
                return (
                  <tr 
                    key={u.user_id} 
                    className={`hover:bg-slate-50/50 transition-colors ${u.disabled ? "bg-slate-50/60 opacity-75" : ""}`}
                    data-testid={`user-row-${u.user_id}`}
                  >
                    <td className="p-4">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#1B3F94]/10 text-sm font-bold text-[#1B3F94]">
                          {(u.name || "U").charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <div className="font-semibold text-slate-900 flex items-center gap-2">
                            {u.name}
                            {isSelf && (
                              <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-700">
                                You
                              </span>
                            )}
                          </div>
                          {u.username && (
                            <div className="text-xs text-slate-400 font-mono">@{u.username}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="p-4 text-slate-600 font-mono text-xs">{u.email}</td>
                    <td className="p-4">
                      <NativeSelect
                        testId={`role-select-${u.user_id}`}
                        value={u.role}
                        onChange={(r) => changeRole(u.user_id, r)}
                        options={(data?.roles || []).map((r) => ({ value: r, label: ROLE_LABELS[r] || r }))}
                        className="text-xs py-1"
                      />
                    </td>
                    <td className="p-4">
                      {u.has_password ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                          <KeyRound className="h-3 w-3 text-emerald-600" /> Local Password
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                          LDAP / SSO
                        </span>
                      )}
                    </td>
                    <td className="p-4">
                      {u.disabled ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700">
                          <XCircle className="h-3 w-3 text-red-600" /> Deactivated
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                          <CheckCircle2 className="h-3 w-3 text-emerald-600" /> Active
                        </span>
                      )}
                    </td>
                    <td className="p-4 text-xs text-slate-500 whitespace-nowrap">{fmtDate(u.created_at)}</td>
                    <td className="p-4 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          data-testid={`reset-pw-${u.user_id}`}
                          title="Reset user password"
                          onClick={() => {
                            setResetTarget(u);
                            setNewPassword(generateSecurePassword());
                          }}
                          className="h-8 gap-1.5 px-2.5 text-xs text-[#1B3F94] hover:bg-[#1B3F94]/10 hover:text-[#1B3F94]"
                        >
                          <KeyRound className="h-3.5 w-3.5" />
                          <span>Reset Pw</span>
                        </Button>

                        {!isSelf && (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              data-testid={`toggle-status-${u.user_id}`}
                              title={u.disabled ? "Activate user" : "Deactivate user"}
                              onClick={() => toggleStatus(u)}
                              className={`h-8 w-8 p-0 ${u.disabled ? "text-emerald-600 hover:bg-emerald-50" : "text-amber-600 hover:bg-amber-50"}`}
                            >
                              {u.disabled ? <UserCheck className="h-4 w-4" /> : <UserX className="h-4 w-4" />}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              data-testid={`delete-user-${u.user_id}`}
                              title="Delete user"
                              onClick={() => setDeleteTarget(u)}
                              className="h-8 w-8 p-0 text-red-600 hover:bg-red-50"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Add User Modal */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleCreateUser}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <UserPlus className="h-5 w-5 text-[#1B3F94]" /> Add New User
              </DialogTitle>
              <DialogDescription>
                Create a new user account with role-based access and credentials.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Full Name *</label>
                <Input
                  required
                  placeholder="e.g. Ramesh Patel"
                  value={newUserData.name}
                  onChange={(e) => setNewUserData({ ...newUserData, name: e.target.value })}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Email Address *</label>
                <Input
                  required
                  type="email"
                  placeholder="ramesh.patel@jswshakti.in"
                  value={newUserData.email}
                  onChange={(e) => setNewUserData({ ...newUserData, email: e.target.value })}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Username (Optional)</label>
                  <Input
                    placeholder="ramesh"
                    value={newUserData.username}
                    onChange={(e) => setNewUserData({ ...newUserData, username: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Role *</label>
                  <NativeSelect
                    value={newUserData.role}
                    onChange={(r) => setNewUserData({ ...newUserData, role: r })}
                    options={(data?.roles || []).map((r) => ({ value: r, label: ROLE_LABELS[r] || r }))}
                    className="w-full"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-semibold text-slate-700">Initial Password</label>
                  <button
                    type="button"
                    onClick={() => setNewUserData({ ...newUserData, password: generateSecurePassword() })}
                    className="flex items-center gap-1 text-[11px] text-[#1B3F94] hover:underline"
                  >
                    <RefreshCw className="h-3 w-3" /> Generate Password
                  </button>
                </div>
                <div className="relative">
                  <Input
                    type={showAddPw ? "text" : "password"}
                    placeholder="Enter password or use generated"
                    value={newUserData.password}
                    onChange={(e) => setNewUserData({ ...newUserData, password: e.target.value })}
                    className="pr-10 font-mono text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowAddPw(!showAddPw)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    {showAddPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  The user can sign in via the Company Login screen using this email or username and password.
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={addingUser} className="bg-[#1B3F94] hover:bg-[#14306F] text-white">
                {addingUser ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <UserPlus className="h-4 w-4 mr-2" />}
                Create User
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Reset Password Modal */}
      <Dialog open={!!resetTarget} onOpenChange={(open) => !open && setResetTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleResetPassword}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <KeyRound className="h-5 w-5 text-[#E31E24]" /> Reset User Password
              </DialogTitle>
              <DialogDescription>
                Assign a new login password for <span className="font-semibold text-slate-900">{resetTarget?.name}</span> ({resetTarget?.email}).
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-semibold text-slate-700">New Password</label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(newPassword);
                        toast.success("Password copied to clipboard!");
                      }}
                      className="flex items-center gap-1 text-[11px] text-slate-600 hover:text-slate-900"
                    >
                      <Copy className="h-3 w-3" /> Copy
                    </button>
                    <button
                      type="button"
                      onClick={() => setNewPassword(generateSecurePassword())}
                      className="flex items-center gap-1 text-[11px] text-[#1B3F94] hover:underline"
                    >
                      <RefreshCw className="h-3 w-3" /> Generate Random
                    </button>
                  </div>
                </div>
                <div className="relative">
                  <Input
                    required
                    type={showResetPw ? "text" : "password"}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="pr-10 font-mono text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowResetPw(!showResetPw)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    {showResetPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <p className="mt-1.5 text-xs text-slate-500">
                  Once updated, the user will immediately be able to sign in with this new password.
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setResetTarget(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={resettingPw} className="bg-[#E31E24] hover:bg-[#b8181c] text-white">
                {resettingPw ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <KeyRound className="h-4 w-4 mr-2" />}
                Reset Password
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete User Confirmation Modal */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <ShieldAlert className="h-5 w-5" /> Delete User Account
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to permanently delete <span className="font-semibold text-slate-900">{deleteTarget?.name}</span>? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={deletingUser}
              onClick={handleDeleteUser}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {deletingUser ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Trash2 className="h-4 w-4 mr-2" />}
              Delete Account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
