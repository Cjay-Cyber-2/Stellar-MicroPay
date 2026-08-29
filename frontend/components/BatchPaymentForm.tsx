import { useMemo, useRef, useState } from "react";
import {
  buildPaymentTransaction,
  isValidStellarAddress,
  STELLAR_MEMO_TEXT_MAX_BYTES,
  STELLAR_MINIMUM_ACCOUNT_BALANCE_XLM,
  submitTransaction,
  truncateMemoText,
  MAX_BATCH_RECIPIENTS,
  MAX_BATCH_TOTAL_XLM,
} from "@/lib/stellar";
import { signTransactionWithWallet } from "@/lib/wallet";
import { formatXLMPrecise, parseBatchRecipientsCSV } from "@/utils/format";

const MAX_RECIPIENTS = MAX_BATCH_RECIPIENTS;

type RecipientStatus = "idle" | "pending" | "success" | "failed";

type BatchRecipient = {
  id: string;
  address: string;
  amount: string;
  memo: string;
  status: RecipientStatus;
  error?: string;
  transactionHash?: string;
};

interface BatchPaymentFormProps {
  publicKey: string;
  xlmBalance: string;
  onBatchSuccess?: () => void;
}

function createRecipient(overrides: Partial<BatchRecipient> = {}): BatchRecipient {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    address: "",
    amount: "",
    memo: "",
    status: "idle",
    ...overrides,
  };
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsText(file);
  });
}

export default function BatchPaymentForm({
  publicKey,
  xlmBalance,
  onBatchSuccess,
}: BatchPaymentFormProps) {
  const [recipients, setRecipients] = useState<BatchRecipient[]>([
    createRecipient(),
  ]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [batchMessage, setBatchMessage] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const xlmBalanceValue = parseFloat(xlmBalance || "0");
  const availableXLM = Math.max(
    0,
    xlmBalanceValue - STELLAR_MINIMUM_ACCOUNT_BALANCE_XLM
  );

  const totalXLM = useMemo(
    () =>
      recipients.reduce((sum, recipient) => {
        const amount = parseFloat(recipient.amount);
        return sum + (Number.isFinite(amount) && amount > 0 ? amount : 0);
      }, 0),
    [recipients]
  );

  const hasFailed = recipients.some((recipient) => recipient.status === "failed");
  const hasPending = recipients.some((recipient) => recipient.status === "pending");
  const hasSuccess = recipients.some((recipient) => recipient.status === "success");
  const exceedsAggregateLimit = totalXLM > MAX_BATCH_TOTAL_XLM;
  const exceedsBalance = totalXLM > availableXLM;
  
  const canSubmit =
    !isProcessing &&
    !exceedsAggregateLimit &&
    !exceedsBalance &&
    recipients.some(
      (recipient) =>
        isValidStellarAddress(recipient.address) &&
        parseFloat(recipient.amount) > 0 &&
        recipient.address !== publicKey
    );

  const updateRecipient = (
    id: string,
    update: Partial<BatchRecipient>
  ) => {
    setRecipients((current) =>
      current.map((recipient) =>
        recipient.id === id ? { ...recipient, ...update } : recipient
      )
    );
  };

  const handleAddRecipient = () => {
    if (recipients.length >= MAX_RECIPIENTS) return;
    setRecipients((current) => [...current, createRecipient()]);
    setBatchMessage(null);
  };

  const handleRemoveRecipient = (id: string) => {
    setRecipients((current) => current.filter((recipient) => recipient.id !== id));
    setBatchMessage(null);
  };

  const importRecipientsFromCSV = (csv: string) => {
    const rows = parseBatchRecipientsCSV(csv);

    if (rows.length === 0) {
      setImportMessage("No recipients found in that CSV file.");
      return;
    }

    const accepted = rows.slice(0, MAX_RECIPIENTS);
    const skipped = rows.length - accepted.length;

    const imported = accepted.map((row) => {
      const error =
        row.error ??
        (!isValidStellarAddress(row.address)
          ? "Invalid Stellar address."
          : row.address === publicKey
            ? "Recipient address cannot be the same as your wallet."
            : null);

      return createRecipient({
        address: row.address,
        amount: row.amount,
        memo: truncateMemoText(row.memo),
        status: error ? "failed" : "idle",
        error: error ?? undefined,
      });
    });

    setRecipients(imported);
    setBatchMessage(null);

    const invalidCount = imported.filter((recipient) => recipient.status === "failed").length;
    const validCount = imported.length - invalidCount;

    const parts = [`Imported ${validCount} recipient${validCount === 1 ? "" : "s"}.`];
    if (invalidCount > 0) {
      parts.push(
        `${invalidCount} row${invalidCount === 1 ? "" : "s"} need attention — see the errors below.`
      );
    }
    if (skipped > 0) {
      parts.push(`${skipped} extra row${skipped === 1 ? "" : "s"} skipped (max ${MAX_RECIPIENTS}).`);
    }
    setImportMessage(parts.join(" "));
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      importRecipientsFromCSV(text);
    } catch (err) {
      setImportMessage((err as Error).message);
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleProcessBatch = async () => {
    if (!canSubmit) return;

    if (totalXLM > MAX_BATCH_TOTAL_XLM) {
      setBatchMessage(`Batch aggregate amount exceeds maximum limit of ${MAX_BATCH_TOTAL_XLM} XLM.`);
      return;
    }

    if (exceedsBalance) {
      setBatchMessage("Total batch amount exceeds available XLM balance.");
      return;
    }

    setIsProcessing(true);
    setBatchMessage(null);

    const validRecipients = recipients.filter(
      (r) => isValidStellarAddress(r.address) && parseFloat(r.amount) > 0 && r.address !== publicKey
    );

    try {
      const tx = await buildPaymentTransaction({
        sourcePublicKey: publicKey,
        destinations: validRecipients.map((r) => ({
          destination: r.address,
          amount: r.amount,
          memo: r.memo,
        })),
      });

      const { signedXDR, error } = await signTransactionWithWallet(tx.toXDR());
      if (error || !signedXDR) {
        throw new Error(error || "User denied signature or wallet error.");
      }

      const result = await submitTransaction(signedXDR);
      setBatchMessage(`Batch transaction submitted successfully! Hash: ${result.hash}`);
      if (onBatchSuccess) onBatchSuccess();
    } catch (err) {
      setBatchMessage(`Batch failed: ${(err as Error).message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 text-white max-w-2xl mx-auto shadow-xl">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-xl font-bold">Batch Payment Form</h2>
          <p className="text-xs text-slate-400 mt-1">
            Send up to {MAX_RECIPIENTS} recipients in a single batch (Max aggregate: {MAX_BATCH_TOTAL_XLM} XLM).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="file"
            accept=".csv"
            ref={fileInputRef}
            onChange={handleImportFile}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs font-medium rounded-lg transition"
          >
            Import CSV
          </button>
        </div>
      </div>

      {importMessage && (
        <div className="mb-4 p-3 bg-slate-800/80 border border-slate-700 text-xs rounded-lg text-slate-300">
          {importMessage}
        </div>
      )}

      <div className="space-y-4 mb-6">
        {recipients.map((recipient, idx) => (
          <div key={recipient.id} className="p-4 bg-slate-950/50 border border-slate-800 rounded-xl space-y-3">
            <div className="flex justify-between items-center text-xs text-slate-400">
              <span>Recipient #{idx + 1}</span>
              {recipients.length > 1 && (
                <button
                  type="button"
                  onClick={() => handleRemoveRecipient(recipient.id)}
                  className="text-red-400 hover:text-red-300"
                >
                  Remove
                </button>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="md:col-span-2">
                <input
                  type="text"
                  placeholder="G..."
                  value={recipient.address}
                  onChange={(e) => updateRecipient(recipient.id, { address: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-white focus:outline-none focus:border-stellar-500"
                />
              </div>
              <div>
                <input
                  type="number"
                  step="any"
                  placeholder="0.5"
                  value={recipient.amount}
                  onChange={(e) => updateRecipient(recipient.id, { amount: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-white focus:outline-none focus:border-stellar-500"
                />
              </div>
            </div>
            {recipient.error && (
              <p className="text-xs text-red-400">{recipient.error}</p>
            )}
          </div>
        ))}
      </div>

      <div className="flex justify-between items-center mb-6">
        <button
          type="button"
          onClick={handleAddRecipient}
          disabled={recipients.length >= MAX_RECIPIENTS}
          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-xs font-semibold rounded-lg transition"
        >
          Add recipient ({recipients.length} / {MAX_RECIPIENTS})
        </button>
        <div className="text-right text-xs">
          <span className="text-slate-400">Total: </span>
          <span className={`font-bold ${exceedsAggregateLimit || exceedsBalance ? "text-red-400" : "text-white"}`}>
            {totalXLM.toFixed(7)} XLM
          </span>
        </div>
      </div>

      {exceedsAggregateLimit && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 text-xs text-red-400 rounded-lg">
          Aggregate payment amount exceeds the maximum limit of {MAX_BATCH_TOTAL_XLM} XLM.
        </div>
      )}

      {exceedsBalance && !exceedsAggregateLimit && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 text-xs text-red-400 rounded-lg">
          Total batch amount exceeds available XLM balance ({availableXLM.toFixed(7)} XLM).
        </div>
      )}

      {batchMessage && (
        <div className="mb-4 p-3 bg-slate-800 border border-slate-700 text-xs rounded-lg text-slate-200">
          {batchMessage}
        </div>
      )}

      <button
        type="button"
        onClick={handleProcessBatch}
        disabled={!canSubmit}
        className="w-full py-3 bg-stellar-600 hover:bg-stellar-500 disabled:opacity-50 text-white font-semibold rounded-xl transition"
      >
        {isProcessing ? "Processing Batch..." : "Send batch"}
      </button>
    </div>
  );
}
