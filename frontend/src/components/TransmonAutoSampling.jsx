import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Eye,
  Play,
  RefreshCw,
  Save,
  Trash2,
  UserCheck
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useApi, errMsg } from "@/lib/api";
import { NativeSelect, Empty } from "@/components/common";

export default function TransmonAutoSampling() {
  const api = useApi();

  // Form Fields matching AutoSampling.aspx
  const [processName, setProcessName] = useState("SM FORM");
  const [sampleCount, setSampleCount] = useState(10);
  const [fromDate, setFromDate] = useState("2026-11-01");
  const [toDate, setToDate] = useState("2026-11-26");
  const [previousSampling, setPreviousSampling] = useState(true);
  const [auditType, setAuditType] = useState("Normal");
  const [year, setYear] = useState("2026");
  const [month, setMonth] = useState("November");
  const [week, setWeek] = useState("Week 4");
  const [samplingTo, setSamplingTo] = useState("");

  // Plan & Process state
  const [metadata, setMetadata] = useState({
    processes: ["SM FORM"],
    evaluators: [],
    years: ["2026", "2025", "2024"],
    months: ["November"],
    weeks: ["Week 4"],
    audit_types: ["Normal", "Targeted", "High Value Orders", "Fatal Re-audit"]
  });

  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generatedPlan, setGeneratedPlan] = useState(null);
  const [processesList, setProcessesList] = useState([]);
  const [selectedPlanDetail, setSelectedPlanDetail] = useState(null);

  // Load Metadata & Saved Processes
  const loadInitial = useCallback(async () => {
    try {
      const metaRes = await api.get("/qa-ops/transmon/metadata");
      setMetadata(metaRes.data);
      if (metaRes.data.evaluators?.length > 0 && !samplingTo) {
        setSamplingTo(metaRes.data.evaluators[0].value);
      }

      const procRes = await api.get("/qa-ops/transmon/sampling-processes");
      setProcessesList(procRes.data);
    } catch (e) {
      toast.error(errMsg(e) || "Failed to load sampling configuration");
    }
  }, [api, samplingTo]);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  const handleGenerateSampling = async () => {
    if (!samplingTo) {
      toast.error("Please select an auditor in 'Sampling To'");
      return;
    }
    setGenerating(true);
    try {
      const payload = {
        process_name: processName,
        sample_count: Number(sampleCount),
        from_date: fromDate,
        to_date: toDate,
        previous_sampling: previousSampling,
        audit_type: auditType,
        year,
        month,
        week,
        sampling_to: samplingTo
      };
      const res = await api.post("/qa-ops/transmon/generate-sampling", payload);
      setGeneratedPlan(res.data.plan);
      toast.success(`Generated ${res.data.count_generated} audit samples`);
    } catch (e) {
      toast.error(errMsg(e) || "Failed to generate sampling plan");
    } finally {
      setGenerating(false);
    }
  };

  const handleSaveSampling = async () => {
    if (!generatedPlan) {
      toast.error("No sampling plan generated yet");
      return;
    }
    setSaving(true);
    try {
      const res = await api.post("/qa-ops/transmon/save-sampling", generatedPlan);
      toast.success(res.data.message || "Sampling plan saved successfully");
      loadInitial();
    } catch (e) {
      toast.error(errMsg(e) || "Failed to save sampling plan");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteProcess = async (processId) => {
    if (!window.confirm("Are you sure you want to delete this sampling batch?")) return;
    try {
      await api.delete(`/qa-ops/transmon/sampling-processes/${processId}`);
      toast.success("Sampling batch deleted");
      loadInitial();
    } catch (e) {
      toast.error(errMsg(e) || "Failed to delete sampling batch");
    }
  };

  const processOptions = (metadata.processes || ["SM FORM"]).map((p) => ({ value: p, label: p }));
  const evaluatorOptions = (metadata.evaluators || []).map((e) => ({ value: e.value, label: e.label }));
  const yearOptions = (metadata.years || ["2026"]).map((y) => ({ value: y, label: y }));
  const monthOptions = (metadata.months || ["November"]).map((m) => ({ value: m, label: m }));
  const weekOptions = (metadata.weeks || ["Week 4"]).map((w) => ({ value: w, label: w }));
  const auditTypeOptions = (metadata.audit_types || ["Normal"]).map((t) => ({ value: t, label: t }));

  return (
    <div className="space-y-6">
      {/* 1. SAMPLING PARAMETERS BOX - Styled with CadenceCX theme */}
      <div className="card-surface overflow-hidden">
        <div className="border-b border-slate-200 bg-slate-50/70 px-5 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="h-2 w-2 rounded-full bg-[#1B3F94]" />
            <h2 className="text-sm font-bold text-[#16357F] tracking-wide uppercase">Auto-Sampling Criteria</h2>
          </div>
          <span className="label-mono">Sampling Engine</span>
        </div>

        <div className="p-6 space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                Process Name
              </label>
              <NativeSelect
                value={processName}
                onChange={setProcessName}
                options={processOptions}
                className="bg-white border-slate-200 focus:ring-2 focus:ring-[#1B3F94]"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                Number of Audit Samples
              </label>
              <Input
                type="number"
                min="1"
                max="500"
                value={sampleCount}
                onChange={(e) => setSampleCount(e.target.value)}
                className="bg-white border-slate-200 h-9 text-sm focus:ring-2 focus:ring-[#1B3F94]"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-5 items-end">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                From Date
              </label>
              <Input
                type="text"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                placeholder="YYYY-MM-DD"
                className="bg-white border-slate-200 h-9 text-sm focus:ring-2 focus:ring-[#1B3F94]"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                To Date
              </label>
              <Input
                type="text"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                placeholder="YYYY-MM-DD"
                className="bg-white border-slate-200 h-9 text-sm focus:ring-2 focus:ring-[#1B3F94]"
              />
            </div>
            <div className="flex items-center h-9">
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={previousSampling}
                  onChange={(e) => setPreviousSampling(e.target.checked)}
                  className="accent-[#1B3F94] h-4 w-4 rounded"
                />
                <span>Include Previous Sampling</span>
              </label>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                Audit Type
              </label>
              <NativeSelect
                value={auditType}
                onChange={setAuditType}
                options={auditTypeOptions}
                className="bg-white border-slate-200 focus:ring-2 focus:ring-[#1B3F94]"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-5">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                Select Year
              </label>
              <NativeSelect
                value={year}
                onChange={setYear}
                options={yearOptions}
                className="bg-white border-slate-200 focus:ring-2 focus:ring-[#1B3F94]"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                Select Month
              </label>
              <NativeSelect
                value={month}
                onChange={setMonth}
                options={monthOptions}
                className="bg-white border-slate-200 focus:ring-2 focus:ring-[#1B3F94]"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                Select Week
              </label>
              <NativeSelect
                value={week}
                onChange={setWeek}
                options={weekOptions}
                className="bg-white border-slate-200 focus:ring-2 focus:ring-[#1B3F94]"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                Sampling To (Auditor)
              </label>
              <NativeSelect
                value={samplingTo}
                onChange={setSamplingTo}
                options={evaluatorOptions}
                className="bg-white border-slate-200 focus:ring-2 focus:ring-[#1B3F94]"
              />
            </div>
          </div>
        </div>
      </div>

      {/* 2. SAMPLING PLAN BOX */}
      <div className="card-surface overflow-hidden">
        <div className="border-b border-slate-200 bg-slate-50/70 px-5 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="h-2 w-2 rounded-full bg-[#1B3F94]" />
            <h2 className="text-sm font-bold text-[#16357F] tracking-wide uppercase">Sampling Plan & Generation</h2>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={loadInitial}
            className="text-slate-500 hover:text-[#1B3F94] h-8"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Button
                onClick={handleGenerateSampling}
                disabled={generating}
                className="bg-[#1B3F94] hover:bg-[#153275] text-white font-medium px-5 shadow-sm"
              >
                {generating ? <RefreshCw className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}
                Generate Sampling
              </Button>
              <Button
                onClick={handleSaveSampling}
                disabled={saving || !generatedPlan}
                className="bg-[#E31E24] hover:bg-[#c41419] text-white font-medium px-5 shadow-sm disabled:opacity-50"
              >
                {saving ? <RefreshCw className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
                Save Sampling Batch
              </Button>
            </div>

            <div className="text-xs font-medium text-slate-600">
              Count of Sampling Generated: <strong className="text-[#1B3F94] font-mono text-base">{generatedPlan ? generatedPlan.actual_generated : 0}</strong>
            </div>
          </div>

          {/* Generated Plan Details & Sample list */}
          {generatedPlan && (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/50 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div>
                  <span className="font-semibold text-slate-700">Generated Batch:</span>{" "}
                  <span className="font-mono text-[#1B3F94] font-bold">{generatedPlan.id}</span> ·{" "}
                  <span>{generatedPlan.process_name}</span> ({generatedPlan.week}, {generatedPlan.month} {generatedPlan.year})
                </div>
                <div>
                  <span className="font-semibold text-slate-700">Assigned To:</span>{" "}
                  <span className="text-slate-900 font-medium">{generatedPlan.sampling_to}</span>
                </div>
              </div>

              {generatedPlan.samples?.length > 0 && (
                <div className="overflow-x-auto rounded border border-slate-200 bg-white">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-slate-50 text-slate-600 font-bold uppercase tracking-wider text-[11px] text-left border-b border-slate-200">
                        <th className="p-2.5">Audit ID</th>
                        <th className="p-2.5">Agent Name</th>
                        <th className="p-2.5">Order ID</th>
                        <th className="p-2.5">City</th>
                        <th className="p-2.5 text-right">Score</th>
                        <th className="p-2.5">Fatal</th>
                        <th className="p-2.5">Category</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {generatedPlan.samples.map((s, idx) => (
                        <tr key={s["Audit Id"] || idx} className="hover:bg-slate-50/80">
                          <td className="p-2.5 font-mono font-medium text-slate-900">{s["Audit Id"]}</td>
                          <td className="p-2.5 text-slate-800">{s["Agentname"]}</td>
                          <td className="p-2.5 font-mono text-[#1B3F94] font-semibold">{s["Order Id"]}</td>
                          <td className="p-2.5 text-slate-600">{s["City Name"]}</td>
                          <td className="p-2.5 text-right font-mono font-semibold">{s["Audit Score"]}%</td>
                          <td className="p-2.5">
                            {s["Fatal Status"] === "Yes" ? (
                              <span className="text-red-600 font-bold">Yes</span>
                            ) : (
                              <span className="text-slate-400">No</span>
                            )}
                          </td>
                          <td className="p-2.5 text-slate-600">{s["Issue Category"]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 3. SAMPLING PROCESS BOX - History Log */}
      <div className="card-surface overflow-hidden">
        <div className="border-b border-slate-200 bg-slate-50/70 px-5 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="h-2 w-2 rounded-full bg-[#1B3F94]" />
            <h2 className="text-sm font-bold text-[#16357F] tracking-wide uppercase">Sampling Process Batches</h2>
          </div>
          <span className="text-xs text-slate-500 font-mono">{processesList.length} total batches</span>
        </div>

        <div className="overflow-x-auto">
          {processesList.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-400">
              No sampling processes recorded yet. Use the form above to generate and save a sampling batch.
            </div>
          ) : (
            <table className="w-full text-xs min-w-[700px]">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-bold uppercase tracking-wider text-[11px] text-left">
                  <th className="p-3">Process ID</th>
                  <th className="p-3">Process Name</th>
                  <th className="p-3 text-right">Samples</th>
                  <th className="p-3">Assigned Auditor</th>
                  <th className="p-3">Period</th>
                  <th className="p-3">Date Range</th>
                  <th className="p-3">Status</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {processesList.map((proc) => (
                  <tr key={proc.id} className="hover:bg-slate-50/80">
                    <td className="p-3 font-mono font-medium text-slate-900">{proc.id}</td>
                    <td className="p-3 text-slate-800 font-medium">{proc.process_name}</td>
                    <td className="p-3 text-right font-mono font-semibold text-[#1B3F94]">
                      {proc.actual_generated || proc.sample_count}
                    </td>
                    <td className="p-3 text-slate-700">{proc.sampling_to}</td>
                    <td className="p-3 text-slate-600">{proc.week}, {proc.month} {proc.year}</td>
                    <td className="p-3 text-slate-500 font-mono text-[11px]">{proc.from_date} ~ {proc.to_date}</td>
                    <td className="p-3">
                      <span className="inline-flex items-center gap-1 bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded text-[10px] font-semibold">
                        <CheckCircle2 className="h-3 w-3" /> {proc.status || "Saved"}
                      </span>
                    </td>
                    <td className="p-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setSelectedPlanDetail(proc)}
                          className="h-7 w-7 text-slate-600 hover:text-[#1B3F94]"
                          title="View Sampled IDs"
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => handleDeleteProcess(proc.id)}
                          className="h-7 w-7 text-slate-400 hover:text-red-600"
                          title="Delete Process"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Plan Details Dialog */}
      {selectedPlanDetail && (
        <Dialog open onOpenChange={() => setSelectedPlanDetail(null)}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader className="border-b border-slate-200 pb-3">
              <div className="label-mono">Sampling Batch Details</div>
              <DialogTitle className="text-base font-bold text-[#16357F] mt-1">
                Batch {selectedPlanDetail.id} · {selectedPlanDetail.process_name}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 text-xs pt-2">
              <div className="grid grid-cols-2 gap-3 bg-slate-50 p-3 rounded-lg border border-slate-200">
                <div><strong>Process:</strong> {selectedPlanDetail.process_name}</div>
                <div><strong>Auditor:</strong> {selectedPlanDetail.sampling_to}</div>
                <div><strong>Audit Type:</strong> {selectedPlanDetail.audit_type}</div>
                <div><strong>Count:</strong> {selectedPlanDetail.actual_generated || selectedPlanDetail.sample_count}</div>
                <div><strong>Period:</strong> {selectedPlanDetail.week}, {selectedPlanDetail.month} {selectedPlanDetail.year}</div>
                <div><strong>Date Range:</strong> {selectedPlanDetail.from_date} to {selectedPlanDetail.to_date}</div>
              </div>

              <div>
                <h4 className="font-semibold text-slate-800 mb-2">Sampled Audit IDs ({selectedPlanDetail.sample_ids?.length || 0})</h4>
                <div className="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto p-2 border border-slate-200 rounded bg-white">
                  {(selectedPlanDetail.sample_ids || []).map((sid) => (
                    <span key={sid} className="bg-slate-100 text-slate-700 font-mono text-[11px] px-2 py-0.5 rounded border border-slate-200">
                      {sid}
                    </span>
                  ))}
                </div>
              </div>

              <div className="flex justify-end pt-2 border-t border-slate-200">
                <Button variant="outline" size="sm" onClick={() => setSelectedPlanDetail(null)}>
                  Close
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
