import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  Eye,
  FileSpreadsheet,
  Filter,
  RefreshCw,
  Search,
  Upload,
  X,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  ShieldAlert,
  CheckCircle2,
  AlertCircle
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApi, errMsg } from "@/lib/api";
import { NativeSelect, Empty } from "@/components/common";

const SEARCH_FIELDS = [
  { value: "id", label: "id" },
  { value: "Audit Id", label: "Audit Id" },
  { value: "Agentid", label: "Agentid" },
  { value: "Agentname", label: "Agentname" },
  { value: "Order Id", label: "Order Id" },
  { value: "City Name", label: "City Name" },
  { value: "Issue Category", label: "Issue Category" },
  { value: "Teamleader", label: "Teamleader" },
  { value: "Created By", label: "Created By" },
];

const PAGE_SIZES = [
  { value: "10", label: "10" },
  { value: "25", label: "25" },
  { value: "50", label: "50" },
  { value: "100", label: "100" },
];

export default function TransmonAuditReport() {
  const api = useApi();
  const fileInputRef = useRef(null);

  // Filter state
  const [processName, setProcessName] = useState("SM FORM");
  const [fromDate, setFromDate] = useState("2026-11-01");
  const [toDate, setToDate] = useState("2026-11-26");
  const [calcType, setCalcType] = useState("New");

  // Search & Pagination state
  const [pageSize, setPageSize] = useState("10");
  const [searchField, setSearchField] = useState("id");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearch, setActiveSearch] = useState({ field: "id", query: "" });
  const [page, setPage] = useState(1);

  // Data state
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [data, setData] = useState({ items: [], total: 0, total_pages: 1, summary: {} });
  const [metadata, setMetadata] = useState({ processes: ["SM FORM"] });
  const [selectedAudit, setSelectedAudit] = useState(null);

  // Load Metadata
  useEffect(() => {
    api.get("/qa-ops/transmon/metadata")
      .then((r) => setMetadata(r.data))
      .catch(() => {});
  }, [api]);

  // Load Audits
  const loadAudits = useCallback(async (targetPage = page, customSearch = activeSearch) => {
    setLoading(true);
    try {
      const params = {
        process_name: processName === "All" ? "" : processName,
        from_date: fromDate,
        to_date: toDate,
        calc_type: calcType,
        page: targetPage,
        page_size: Number(pageSize),
      };
      if (customSearch.query.trim()) {
        params.search_field = customSearch.field;
        params.search_query = customSearch.query.trim();
      }
      const res = await api.get("/qa-ops/transmon/audits", { params });
      setData(res.data);
      setPage(res.data.page || targetPage);
    } catch (e) {
      toast.error(errMsg(e) || "Failed to load audit records");
    } finally {
      setLoading(false);
    }
  }, [api, processName, fromDate, toDate, calcType, pageSize, page, activeSearch]);

  useEffect(() => {
    loadAudits(page, activeSearch);
  }, [page, pageSize, calcType]);

  const handleGenerate = () => {
    setPage(1);
    loadAudits(1, activeSearch);
    toast.success("Audit records generated");
  };

  const handleSearch = () => {
    const newSearch = { field: searchField, query: searchQuery };
    setActiveSearch(newSearch);
    setPage(1);
    loadAudits(1, newSearch);
  };

  const handleClear = () => {
    setSearchQuery("");
    const cleared = { field: searchField, query: "" };
    setActiveSearch(cleared);
    setPage(1);
    loadAudits(1, cleared);
  };

  const handleDownloadExcel = async () => {
    try {
      const res = await api.get("/qa-ops/transmon/export", {
        params: {
          process_name: processName === "All" ? "" : processName,
          search_query: activeSearch.query,
        },
        responseType: "blob",
      });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `FinalReport_${processName || "All"}.csv`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      toast.success("Excel/CSV export downloaded successfully");
    } catch (e) {
      toast.error("Failed to export Excel report");
    }
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);

    setUploading(true);
    try {
      const res = await api.post("/qa-ops/transmon/import", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      toast.success(res.data.message || `Imported ${res.data.total_parsed} records`);
      loadAudits(1, activeSearch);
    } catch (err) {
      toast.error(errMsg(err) || "Failed to import file");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const processOptions = [
    { value: "All", label: "All Processes" },
    ...(metadata.processes || []).map((p) => ({ value: p, label: p })),
  ];

  return (
    <div className="space-y-6">
      {/* 1. FILTER BOX - Styled like Transmon FinalReport.aspx */}
      <div className="rounded-xl border border-orange-200 bg-white shadow-sm overflow-hidden">
        <div className="border-b border-orange-100 bg-gradient-to-r from-orange-50/60 to-white px-5 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-[#f97316]" />
            <h2 className="text-base font-semibold text-slate-800">Audit Report</h2>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileUpload}
              accept=".xls,.xlsx,.csv"
              className="hidden"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="border-slate-200 text-xs text-slate-700 hover:border-orange-300"
            >
              <Upload className="mr-1.5 h-3.5 w-3.5 text-orange-600" />
              {uploading ? "Importing..." : "Upload Transmon File (.xls/.csv)"}
            </Button>
          </div>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                Process Name:
              </label>
              <NativeSelect
                value={processName}
                onChange={setProcessName}
                options={processOptions}
                className="bg-white border-slate-300"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                From Date:
              </label>
              <Input
                type="text"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                placeholder="YYYY-MM-DD"
                className="bg-white border-slate-300 h-9 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                To Date:
              </label>
              <Input
                type="text"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                placeholder="YYYY-MM-DD"
                className="bg-white border-slate-300 h-9 text-sm"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between pt-2 border-t border-slate-100 gap-4">
            <div className="flex items-center gap-6">
              <span className="text-xs font-semibold text-slate-700">
                Domainwise Calculation Type
              </span>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="radio"
                  name="calcType"
                  value="New"
                  checked={calcType === "New"}
                  onChange={() => setCalcType("New")}
                  className="accent-[#ea580c] h-4 w-4"
                />
                <span>New</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="radio"
                  name="calcType"
                  value="Old"
                  checked={calcType === "Old"}
                  onChange={() => setCalcType("Old")}
                  className="accent-[#ea580c] h-4 w-4"
                />
                <span>Old</span>
              </label>
            </div>

            <div className="flex items-center gap-3">
              <Button
                onClick={handleGenerate}
                disabled={loading}
                className="bg-[#ea580c] hover:bg-[#c2410c] text-white font-medium px-6 shadow-sm"
              >
                {loading ? <RefreshCw className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                Generate
              </Button>
              <Button
                variant="outline"
                onClick={handleDownloadExcel}
                className="border-orange-300 text-orange-700 hover:bg-orange-50 font-medium"
              >
                <FileSpreadsheet className="mr-1.5 h-4 w-4 text-[#ea580c]" />
                Download All Records to Excel
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* 2. LIST OF AUDITS BOX */}
      <div className="rounded-xl border border-orange-200 bg-white shadow-sm overflow-hidden">
        <div className="border-b border-orange-100 bg-gradient-to-r from-orange-50/60 to-white px-5 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-[#f97316]" />
            <h2 className="text-base font-semibold text-slate-800">List of Audits</h2>
          </div>
          {data.summary && (
            <div className="flex items-center gap-4 text-xs font-medium text-slate-500">
              <span>Avg Score: <strong className="text-slate-800 font-mono">{data.summary.avg_score || 0}%</strong></span>
              <span>Fatals: <strong className="text-red-600 font-mono">{data.summary.fatal_count || 0}</strong></span>
              <span>ZTP: <strong className="text-amber-600 font-mono">{data.summary.ztp_count || 0}</strong></span>
            </div>
          )}
        </div>

        {/* Toolbar: Page size, Search field, input, buttons & row count */}
        <div className="p-4 border-b border-slate-100 bg-slate-50/50 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-medium text-slate-600">Page Size:</span>
            <div className="w-20">
              <NativeSelect
                value={pageSize}
                onChange={(v) => { setPageSize(v); setPage(1); }}
                options={PAGE_SIZES}
                className="bg-white border-slate-300 h-8 text-xs"
              />
            </div>
          </div>

          <div className="flex items-center gap-2 flex-1 max-w-lg">
            <div className="w-36">
              <NativeSelect
                value={searchField}
                onChange={setSearchField}
                options={SEARCH_FIELDS}
                className="bg-white border-slate-300 h-8 text-xs"
              />
            </div>
            <Input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              placeholder="Search keyword..."
              className="bg-white border-slate-300 h-8 text-xs flex-1"
            />
            <Button
              size="sm"
              onClick={handleSearch}
              className="bg-[#ea580c] hover:bg-[#c2410c] text-white h-8 text-xs px-3"
            >
              Search
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleClear}
              className="border-slate-300 h-8 text-xs px-3"
            >
              Clear
            </Button>
          </div>

          <div className="text-xs font-semibold text-slate-600">
            Row Count : <span className="text-[#ea580c] font-mono">{data.items?.length || 0}</span> out of <span className="text-[#ea580c] font-mono">{data.total || 0}</span>
            <span className="mx-3 text-slate-300">|</span>
            Page Number: <span className="text-[#ea580c] font-mono">{page}</span>
          </div>
        </div>

        {/* Table View */}
        <div className="overflow-x-auto">
          {data.items?.length === 0 ? (
            <div className="p-12 text-center text-sm text-slate-500">
              No audit records found. Click <strong>Generate</strong> or upload a Transmon export file.
            </div>
          ) : (
            <table className="w-full min-w-[1600px] text-xs">
              <thead>
                <tr className="bg-slate-100/80 border-b border-slate-200 text-slate-700 font-semibold text-left">
                  <th className="py-2.5 px-3 whitespace-nowrap text-center">Edit/Audit</th>
                  <th className="py-2.5 px-3 whitespace-nowrap">Audit Id</th>
                  <th className="py-2.5 px-3 whitespace-nowrap">Form Id</th>
                  <th className="py-2.5 px-3 whitespace-nowrap text-right">Audit Score</th>
                  <th className="py-2.5 px-3 whitespace-nowrap text-right">Scorable Value</th>
                  <th className="py-2.5 px-3 whitespace-nowrap text-right">Scoring Value</th>
                  <th className="py-2.5 px-3 whitespace-nowrap">Emp Code</th>
                  <th className="py-2.5 px-3 whitespace-nowrap">Transmon Id</th>
                  <th className="py-2.5 px-3 whitespace-nowrap">Agentid</th>
                  <th className="py-2.5 px-3 whitespace-nowrap">Agentname</th>
                  <th className="py-2.5 px-3 whitespace-nowrap">Escalation Date</th>
                  <th className="py-2.5 px-3 whitespace-nowrap">City Name</th>
                  <th className="py-2.5 px-3 whitespace-nowrap">Order Id</th>
                  <th className="py-2.5 px-3 whitespace-nowrap">Issue Category</th>
                  <th className="py-2.5 px-3 whitespace-nowrap">Issue Sub Category</th>
                  <th className="py-2.5 px-3 whitespace-nowrap">Fatal Status</th>
                  <th className="py-2.5 px-3 whitespace-nowrap">Ztp</th>
                  <th className="py-2.5 px-3 whitespace-nowrap">Agent Disposition</th>
                  <th className="py-2.5 px-3 whitespace-nowrap">Teamleader</th>
                  <th className="py-2.5 px-3 whitespace-nowrap">Created By</th>
                  <th className="py-2.5 px-3 whitespace-nowrap">Duration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {data.items.map((row, idx) => {
                  const score = Number(row["Audit Score"] || row["audit_score"] || 0);
                  const isFatal = row["Fatal Status"] === "Yes" || row["fatal_status"] === "Yes";
                  const isZtp = String(row["Ztp"] || row["ztp"]).toLowerCase() === "yes";

                  return (
                    <tr
                      key={row["Audit Id"] || idx}
                      className="hover:bg-orange-50/40 transition-colors"
                    >
                      <td className="py-2 px-3 text-center whitespace-nowrap">
                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            onClick={() => setSelectedAudit(row)}
                            title="Inspect 74-column Audit Details"
                            className="p-1 text-[#ea580c] hover:bg-orange-100 rounded"
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => {
                              setSelectedAudit(row);
                              toast.info(`Viewing details for ${row["Audit Id"]}`);
                            }}
                            title="View Audit Link"
                            className="p-1 text-slate-400 hover:text-slate-600 rounded"
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                      <td className="py-2 px-3 font-mono font-medium text-slate-900 whitespace-nowrap">
                        {row["Audit Id"] || "—"}
                      </td>
                      <td className="py-2 px-3 font-mono text-slate-600 whitespace-nowrap">
                        {row["Form Id"] || "—"}
                      </td>
                      <td className={`py-2 px-3 text-right font-mono font-semibold whitespace-nowrap ${score >= 85 ? "text-emerald-600" : score >= 70 ? "text-amber-600" : "text-slate-700"}`}>
                        {score}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-slate-600 whitespace-nowrap">
                        {row["Scorable Value"] || "0.00"}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-slate-600 whitespace-nowrap">
                        {row["Scoring Value"] || "0"}
                      </td>
                      <td className="py-2 px-3 text-slate-500 whitespace-nowrap">
                        {row["Emp Code"] || "-"}
                      </td>
                      <td className="py-2 px-3 font-mono text-slate-600 whitespace-nowrap">
                        {row["Transmon Id"] || "—"}
                      </td>
                      <td className="py-2 px-3 font-mono text-slate-600 max-w-[140px] truncate" title={row["Agentid"]}>
                        {row["Agentid"] || "—"}
                      </td>
                      <td className="py-2 px-3 text-slate-800 max-w-[140px] truncate" title={row["Agentname"]}>
                        {row["Agentname"] || "—"}
                      </td>
                      <td className="py-2 px-3 text-slate-600 whitespace-nowrap">
                        {row["Escalation Date"] || "—"}
                      </td>
                      <td className="py-2 px-3 text-slate-700 whitespace-nowrap">
                        {row["City Name"] || "—"}
                      </td>
                      <td className="py-2 px-3 font-mono text-[#ea580c] whitespace-nowrap">
                        {row["Order Id"] || "—"}
                      </td>
                      <td className="py-2 px-3 text-slate-700 whitespace-nowrap">
                        {row["Issue Category"] || "—"}
                      </td>
                      <td className="py-2 px-3 text-slate-600 whitespace-nowrap">
                        {row["Issue Sub Category"] || "—"}
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        {isFatal ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-600 bg-red-50 px-2 py-0.5 rounded">
                            <AlertCircle className="h-3 w-3" /> Yes
                          </span>
                        ) : (
                          <span className="text-slate-500">No</span>
                        )}
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        {isZtp ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-600 bg-amber-50 px-2 py-0.5 rounded">
                            Yes
                          </span>
                        ) : (
                          <span className="text-slate-500">No</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-slate-700 whitespace-nowrap">
                        {row["Agent Disposition"] || "—"}
                      </td>
                      <td className="py-2 px-3 text-slate-700 whitespace-nowrap">
                        {row["Teamleader"] || "—"}
                      </td>
                      <td className="py-2 px-3 text-slate-500 max-w-[150px] truncate" title={row["Created By"]}>
                        {row["Created By"] || "—"}
                      </td>
                      <td className="py-2 px-3 font-mono text-slate-600 whitespace-nowrap">
                        {row["Audit Evaluation Duration"] || row["Duration"] || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination Footer */}
        <div className="p-4 border-t border-slate-100 flex items-center justify-between">
          <div className="text-xs text-slate-500">
            Showing {(page - 1) * Number(pageSize) + 1} to {Math.min(page * Number(pageSize), data.total)} of {data.total} records
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
              className="h-8 text-xs px-2.5"
            >
              <ChevronLeft className="h-3.5 w-3.5 mr-1" /> Previous
            </Button>
            <span className="text-xs font-semibold px-2 text-slate-700">
              Page {page} of {data.total_pages || 1}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= (data.total_pages || 1)}
              onClick={() => setPage(page + 1)}
              className="h-8 text-xs px-2.5"
            >
              Next <ChevronRight className="h-3.5 w-3.5 ml-1" />
            </Button>
          </div>
        </div>
      </div>

      {/* 3. DETAIL VIEW MODAL (ALL 74 TRANSMON FIELDS) */}
      {selectedAudit && (
        <Dialog open onOpenChange={() => setSelectedAudit(null)}>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
            <DialogHeader className="border-b pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="label-mono text-[#ea580c]">Transmon Audit Detail</div>
                  <DialogTitle className="text-xl font-bold text-slate-900 mt-1">
                    {selectedAudit["Audit Id"]} · {selectedAudit["Form Id"]}
                  </DialogTitle>
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded bg-slate-100 px-2.5 py-1 font-mono text-xs font-semibold text-slate-700">
                    Transmon ID: {selectedAudit["Transmon Id"] || "—"}
                  </span>
                  <span className={`rounded px-2.5 py-1 font-mono text-xs font-bold ${Number(selectedAudit["Audit Score"] || 0) >= 85 ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
                    Score: {selectedAudit["Audit Score"] || 0}%
                  </span>
                </div>
              </div>
            </DialogHeader>

            <Tabs defaultValue="overview" className="mt-4">
              <TabsList className="grid grid-cols-4 w-full">
                <TabsTrigger value="overview">Overview & Order</TabsTrigger>
                <TabsTrigger value="categorization">Categorization</TabsTrigger>
                <TabsTrigger value="questions">Questions & Rubric</TabsTrigger>
                <TabsTrigger value="rebuttal">Dispositions & Rebuttal</TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="space-y-4 pt-4 text-xs">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <DetailItem label="Audit ID" value={selectedAudit["Audit Id"]} mono />
                  <DetailItem label="Form ID" value={selectedAudit["Form Id"]} mono />
                  <DetailItem label="Order ID" value={selectedAudit["Order Id"]} mono highlight />
                  <DetailItem label="Agent Name" value={selectedAudit["Agentname"]} />
                  <DetailItem label="Agent ID" value={selectedAudit["Agentid"]} mono />
                  <DetailItem label="Team Leader" value={selectedAudit["Teamleader"]} />
                  <DetailItem label="City Name" value={selectedAudit["City Name"]} />
                  <DetailItem label="Escalation Date" value={selectedAudit["Escalation Date"]} />
                  <DetailItem label="Escalation Time" value={selectedAudit["Escalation Time"]} />
                  <DetailItem label="Escalation Type" value={selectedAudit["Escalation Type"]} />
                  <DetailItem label="Chat Ticket ID" value={selectedAudit["Chat Ticket Id"]} mono />
                  <DetailItem label="Konnect ID" value={selectedAudit["Konnect Id"]} mono />
                  <DetailItem label="Queue" value={selectedAudit["Queue"]} />
                  <DetailItem label="Duration" value={selectedAudit["Audit Evaluation Duration"]} mono />
                  <DetailItem label="Evaluator (Created By)" value={selectedAudit["Created By"]} />
                  <DetailItem label="Created On Date" value={selectedAudit["Createdon Date"]} />
                  <DetailItem label="Audit Start Date" value={selectedAudit["Audit Start Date"]} />
                  <DetailItem label="Audit Started Time" value={selectedAudit["Audit Started Time"]} />
                </div>
              </TabsContent>

              <TabsContent value="categorization" className="space-y-4 pt-4 text-xs">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <DetailItem label="Scope" value={selectedAudit["Scope"]} />
                  <DetailItem label="Reason Categorisation" value={selectedAudit["Reason Categorisation"]} />
                  <DetailItem label="Issue Category" value={selectedAudit["Issue Category"]} />
                  <DetailItem label="Issue Sub Category" value={selectedAudit["Issue Sub Category"]} />
                  <DetailItem label="Issue Sub Sub Category" value={selectedAudit["Issue Sub Sub Category"]} />
                  <DetailItem label="RCA Level" value={selectedAudit["Rca Level"]} />
                  <DetailItem label="L1 Reason" value={selectedAudit["L1 Reason"]} />
                  <DetailItem label="L2 Reason" value={selectedAudit["L2 Reason"]} />
                  <DetailItem label="Agent Opportunity" value={selectedAudit["Agent Opportunity"]} />
                  <DetailItem label="CPT Opportunity" value={selectedAudit["Cpt Opportunity"]} />
                  <div className="sm:col-span-2">
                    <DetailItem label="Observations" value={selectedAudit["Observations"]} />
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="questions" className="space-y-4 pt-4 text-xs">
                <div className="space-y-3">
                  <div className="rounded-lg border p-3 bg-slate-50">
                    <div className="font-semibold text-slate-800 mb-1">Question 1</div>
                    <div className="grid grid-cols-2 gap-2">
                      <DetailItem label="Q1 Reason" value={selectedAudit["Q1-Reason"]} />
                      <DetailItem label="Q1 Remarks" value={selectedAudit["Q1-Remarks"]} />
                    </div>
                  </div>
                  <div className="rounded-lg border p-3 bg-slate-50">
                    <div className="font-semibold text-slate-800 mb-1">Question 2</div>
                    <div className="grid grid-cols-2 gap-2">
                      <DetailItem label="Q2 Reason" value={selectedAudit["Q2-Reason"]} />
                      <DetailItem label="Q2 Remarks" value={selectedAudit["Q2-Remarks"]} />
                    </div>
                  </div>
                  <div className="rounded-lg border p-3 bg-slate-50">
                    <div className="font-semibold text-slate-800 mb-1">Question 3</div>
                    <div className="grid grid-cols-2 gap-2">
                      <DetailItem label="Q3 Reason" value={selectedAudit["Q3-Reason"]} />
                      <DetailItem label="Q3 Remarks" value={selectedAudit["Q3-Remarks"]} />
                    </div>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="rebuttal" className="space-y-4 pt-4 text-xs">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <DetailItem label="Fatal Status" value={selectedAudit["Fatal Status"]} />
                  <DetailItem label="Fatal Count" value={selectedAudit["Fatal Count"]} />
                  <DetailItem label="ZTP" value={selectedAudit["Ztp"]} />
                  <DetailItem label="Agent Disposition" value={selectedAudit["Agent Disposition"]} />
                  <DetailItem label="Agent Disposition Date" value={selectedAudit["Agent Disposition Date"]} />
                  <DetailItem label="Agent Disposition Time" value={selectedAudit["Agent Disposition Time"]} />
                  <DetailItem label="TL Disposition By" value={selectedAudit["Tl Disposition By"]} />
                  <DetailItem label="TL Disposition On" value={selectedAudit["Tl Disposition On"]} />
                  <DetailItem label="Rebuttal Status" value={selectedAudit["Rebuttal Status"]} />
                  <DetailItem label="Disagree" value={selectedAudit["Disagree"]} />
                  <DetailItem label="Rebuttal Raised Date" value={selectedAudit["Rebuttal Raised Date"]} />
                  <DetailItem label="Rebuttal Closed Date" value={selectedAudit["Rebuttal Closed Date"]} />
                  <div className="sm:col-span-3">
                    <DetailItem label="Agent Comments" value={selectedAudit["Agent Comments"]} />
                  </div>
                  <div className="sm:col-span-3">
                    <DetailItem label="Rebuttal Comments" value={selectedAudit["Rebuttal Comments"]} />
                  </div>
                </div>
              </TabsContent>
            </Tabs>

            <div className="flex justify-end pt-4 border-t">
              <Button onClick={() => setSelectedAudit(null)} variant="outline">
                Close
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function DetailItem({ label, value, mono = false, highlight = false }) {
  return (
    <div className="rounded border border-slate-200 bg-white p-2">
      <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">{label}</div>
      <div className={`mt-0.5 font-medium ${mono ? "font-mono" : ""} ${highlight ? "text-[#ea580c] font-bold" : "text-slate-800"}`}>
        {value || "—"}
      </div>
    </div>
  );
}
