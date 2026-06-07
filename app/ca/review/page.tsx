"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { MilestoneStatus } from "@/lib/types";

interface MilestoneReview {
  id: string;
  title: string;
  project_title: string;
  ngo_name: string;
  status: MilestoneStatus;
  evidence?: any;
}

export default function CaReviewPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<any>(null);
  const [milestones, setMilestones] = useState<MilestoneReview[]>([]);
  const [selectedMilestone, setSelectedMilestone] = useState<MilestoneReview | null>(null);
  const [evidenceData, setEvidenceData] = useState<any>(null);
  const [remarks, setRemarks] = useState("");
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function init() {
      try {
        const res = await fetch("/api/session");
        const data = await res.json();
        if (!data.session || data.session.role !== "ca") {
          router.replace("/");
          return;
        }
        setSession(data.session);
        await fetchSubmissions();
      } catch (err) {
        setError("Failed to initialize session.");
      } finally {
        setLoading(false);
      }
    }
    init();
  }, [router]);

  useEffect(() => {
    if (selectedMilestone) {
      fetchEvidence(selectedMilestone.id);
    } else {
      setEvidenceData(null);
    }
  }, [selectedMilestone]);

  async function fetchEvidence(milestoneId: string) {
    try {
      const res = await fetch(`/api/review/evidence?milestone_id=${milestoneId}`);
      const data = await res.json();
      if (data.ok) {
        setEvidenceData(data.evidence);
      } else {
        setEvidenceData(null);
      }
    } catch (err) {
      console.error("Failed to fetch evidence:", err);
    }
  }

  async function fetchSubmissions() {
    try {
      setLoading(true);
      const res = await fetch("/api/projects");
      const data = await res.json();
      
      if (data.ok && Array.isArray(data.projects)) {
        const items: MilestoneReview[] = [];
        for (const p of data.projects) {
          if (!p.csr_project_milestones) continue;
          for (const m of p.csr_project_milestones) {
            if (m.status === "submitted" || m.status === "approved" || m.status === "payment_initiated") {
              items.push({
                id: m.id,
                title: m.title,
                project_title: p.title,
                ngo_name: p.region || "NGO",
                status: m.status
              });
            }
          }
        }
        setMilestones(items);
      }
    } catch (err) {
      setError("Failed to fetch tasks.");
    } finally {
      setLoading(false);
    }
  }

  async function handleReview(action: "approve" | "reject") {
    if (!selectedMilestone) return;
    if (action === "reject" && !remarks) {
      alert("Please provide remarks for rejection.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/review/milestone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_id: crypto.randomUUID(),
          milestone_id: selectedMilestone.id,
          action,
          remarks
        })
      });

      const result = await res.json();
      if (result.ok) {
        setSelectedMilestone(null);
        setRemarks("");
        await fetchSubmissions();
      } else {
        setError(result.error || "Action failed.");
      }
    } catch (err) {
      setError("Network error.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePayment() {
    if (!selectedMilestone || !receiptFile) {
      alert("Please upload a payment receipt.");
      return;
    }

    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.append("event_id", crypto.randomUUID());
      formData.append("milestone_id", selectedMilestone.id);
      formData.append("receipt", receiptFile);

      const res = await fetch("/api/payment/complete", {
        method: "POST",
        body: formData
      });

      const result = await res.json();
      if (result.ok) {
        setSelectedMilestone(null);
        setReceiptFile(null);
        await fetchSubmissions();
      } else {
        setError(result.error || "Payment failed.");
      }
    } catch (err) {
      setError("Network error during payment.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <div className="p-12 text-center text-slate-400 font-bold uppercase tracking-widest text-xs">Initializing Review Session...</div>;
  if (!session) return null;

  return (
    <div className="min-h-screen bg-[#f8fafc] text-slate-900 antialiased">
      {/* Precision Header */}
      <header className="bg-white border-b border-slate-200 px-8 py-5 flex justify-between items-center sticky top-0 z-50">
        <div className="flex items-center gap-4">
           <div className="p-1.5 bg-indigo-600 rounded-md">
              <svg viewBox="0 0 100 100" className="h-6 w-6 text-white fill-current">
                <path d="M10 20 L40 20 L80 80 L50 80 Z" />
                <path d="M40 20 C60 20, 90 40, 90 60 C90 80, 60 80, 50 80" stroke="currentColor" strokeWidth="10" fill="none" />
              </svg>
           </div>
           <div>
              <h1 className="text-sm font-bold tracking-tight text-slate-800 uppercase">Audit Portal <span className="text-slate-400 font-normal ml-2">Verification Desk</span></h1>
              <p className="text-[10px] text-slate-500 font-medium uppercase tracking-wider mt-0.5">Authorized Auditor: {session.email}</p>
           </div>
        </div>
        <button onClick={() => router.push("/")} className="text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-slate-900 transition-colors">Sign Out</button>
      </header>

      <main className="max-w-6xl mx-auto p-8">
        <div className="grid grid-cols-12 gap-8 items-start">
          
          {/* Left: Queue Management */}
          <section className="col-span-12 md:col-span-5 space-y-6">
            <div className="flex items-center justify-between px-1">
               <h2 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Active Audit Queue ({milestones.length})</h2>
               <button onClick={fetchSubmissions} className="text-[10px] font-bold text-indigo-600 hover:underline">Refresh List</button>
            </div>

            {milestones.length === 0 ? (
              <div className="bg-white border border-slate-200 border-dashed rounded-2xl p-12 text-center">
                 <p className="text-sm text-slate-300 italic font-medium">No pending submissions to review.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {milestones.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setSelectedMilestone(m)}
                    className={`w-full text-left p-5 rounded-2xl border transition-all ${
                      selectedMilestone?.id === m.id 
                      ? "border-indigo-600 bg-white shadow-xl ring-1 ring-indigo-600 translate-x-2" 
                      : "border-slate-200 bg-white hover:border-slate-300 shadow-sm"
                    }`}
                  >
                    <div className="flex justify-between items-start mb-2">
                      <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">{m.project_title}</span>
                      <span className={`text-[8px] font-black uppercase px-2 py-0.5 rounded-full ${
                        m.status === 'approved' ? 'bg-green-100 text-green-700' : 
                        m.status === 'payment_initiated' ? 'bg-indigo-100 text-indigo-700' :
                        'bg-blue-100 text-blue-700'
                      }`}>
                        {m.status.replace('_', ' ')}
                      </span>
                    </div>
                    <span className="block font-bold text-slate-800 text-base">{m.title}</span>
                    <span className="block text-[11px] text-slate-500 font-medium mt-1">Beneficiary: {m.ngo_name}</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* Right: Inspection & Actions */}
          <section className="col-span-12 md:col-span-7">
            {selectedMilestone ? (
              <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden sticky top-28">
                <div className="px-8 py-6 border-b border-slate-100 bg-slate-50/30 flex justify-between items-center">
                   <div>
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Inspection Desk</span>
                      <h3 className="text-xl font-bold text-slate-900 leading-tight">{selectedMilestone.title}</h3>
                   </div>
                   <div className="text-right">
                      <span className="block text-[9px] font-bold text-slate-400 uppercase">Case ID</span>
                      <span className="text-xs font-mono text-slate-500">{selectedMilestone.id.slice(0, 8)}</span>
                   </div>
                </div>

                <div className="p-8 space-y-8">
                  {/* Evidence Display */}
                  <div className="space-y-4">
                     <label className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">Forensic Evidence Proofs</label>
                     <div className="bg-slate-50 rounded-2xl p-6 border border-slate-100">
                        {evidenceData ? (
                          <div className="space-y-6">
                            <div className="grid grid-cols-3 gap-4">
                              {evidenceData.media.map((m: any, i: number) => (
                                <a key={i} href={m.url} target="_blank" rel="noreferrer" className="aspect-square rounded-xl overflow-hidden border border-slate-200 bg-white hover:scale-105 transition-transform">
                                  <img src={m.url} alt="Proof" className="w-full h-full object-cover" />
                                </a>
                              ))}
                            </div>
                            {evidenceData.notes && (
                              <div className="p-4 bg-white rounded-xl border border-slate-200">
                                <span className="text-[10px] font-bold text-slate-400 uppercase block mb-2">Field Worker Observations</span>
                                <p className="text-sm text-slate-600 leading-relaxed italic">"{evidenceData.notes}"</p>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="py-12 text-center space-y-2">
                             <div className="h-2 w-12 bg-slate-200 rounded-full mx-auto animate-pulse"></div>
                             <p className="text-xs text-slate-400 font-medium">Fetching media assets from secure storage...</p>
                          </div>
                        )}
                     </div>
                  </div>

                  {/* Context-Specific Actions */}
                  {selectedMilestone.status === "submitted" ? (
                    <div className="space-y-6 pt-4 border-t border-slate-100">
                       <div className="space-y-2">
                          <label className="text-[11px] font-bold text-slate-500 uppercase tracking-widest ml-1">Audit Remarks</label>
                          <textarea 
                            className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-sm min-h-[100px] outline-none focus:bg-white focus:ring-2 focus:ring-indigo-600 transition-all"
                            value={remarks}
                            onChange={e => setRemarks(e.target.value)}
                            placeholder="Detail any discrepancies or approval notes..."
                          />
                       </div>
                       <div className="grid grid-cols-2 gap-4">
                          <button disabled={submitting} onClick={() => handleReview("reject")} className="py-4 rounded-2xl font-bold border-2 border-red-100 text-red-600 hover:bg-red-50 transition-all text-xs uppercase tracking-widest">Flag & Reject</button>
                          <button disabled={submitting} onClick={() => handleReview("approve")} className="py-4 rounded-2xl font-bold bg-green-600 text-white hover:bg-green-700 shadow-xl shadow-green-100 transition-all text-xs uppercase tracking-widest">Verify & Approve</button>
                       </div>
                    </div>
                  ) : selectedMilestone.status === "approved" ? (
                    <div className="space-y-6 pt-4 border-t border-slate-100">
                       <div className="bg-green-50 p-6 rounded-2xl border border-green-100 flex items-center gap-4">
                          <div className="h-10 w-10 bg-green-600 text-white rounded-full flex items-center justify-center shrink-0 shadow-lg">
                             <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                          </div>
                          <div>
                             <h4 className="text-sm font-bold text-green-800">Verification Passed</h4>
                             <p className="text-xs text-green-600">This record is legally cleared for disbursement.</p>
                          </div>
                       </div>
                       
                       <div className="space-y-4">
                          <label className="block border-2 border-dashed border-slate-200 rounded-2xl p-8 hover:bg-slate-50 transition-all cursor-pointer group">
                             <div className="text-center space-y-2">
                                <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest group-hover:text-indigo-600">Attach Disbursement Receipt</span>
                                <input 
                                  type="file" 
                                  className="hidden"
                                  onChange={e => setReceiptFile(e.target.files?.[0] || null)}
                                />
                                <p className="text-[10px] text-slate-300 font-medium italic">{receiptFile ? receiptFile.name : 'PDF or Image of Bank Transfer'}</p>
                             </div>
                          </label>
                          <button 
                            disabled={submitting || !receiptFile} 
                            onClick={handlePayment} 
                            className="w-full bg-slate-900 text-white py-5 rounded-2xl font-bold shadow-2xl hover:bg-black active:scale-[0.99] transition-all text-xs uppercase tracking-widest"
                          >
                             Execute Fund Transfer
                          </button>
                       </div>
                    </div>
                  ) : (
                    <div className="bg-indigo-50 p-8 rounded-3xl border border-indigo-100 text-center space-y-2">
                       <div className="h-2 w-12 bg-indigo-200 rounded-full mx-auto"></div>
                       <h4 className="text-sm font-bold text-indigo-800 uppercase tracking-widest">Transaction Sealed</h4>
                       <p className="text-xs text-indigo-500 font-medium">Funds dispatched. Awaiting final NGO receipt ledgering.</p>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="h-[600px] border-2 border-dashed border-slate-100 rounded-[40px] flex flex-col items-center justify-center text-center p-12 space-y-4">
                 <div className="p-4 bg-slate-50 rounded-full">
                    <svg className="h-10 w-10 text-slate-200" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                 </div>
                 <h3 className="text-base font-bold text-slate-300 uppercase tracking-widest">Inspection Idle</h3>
                 <p className="text-sm text-slate-300 max-w-xs font-medium">Please select a submission from the audit queue to begin forensic verification.</p>
              </div>
            )}
          </section>
        </div>
      </main>

      {error && (
        <div className="fixed top-24 right-8 w-80 bg-red-600 text-white p-4 rounded-2xl shadow-2xl text-xs font-bold animate-bounce z-[100]">
           ⚠️ ERROR: {error}
        </div>
      )}
    </div>
  );
}
