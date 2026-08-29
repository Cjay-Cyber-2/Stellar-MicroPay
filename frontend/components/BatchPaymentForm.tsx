import { useMemo, useRef, useState } from "react";
import {
  buildPaymentTransaction,
  isValidStellarAddress,
  STELLAR_MEMO_TEXT_MAX_BYTES,
  STELLAR_MINIMUM_ACCOUNT_BALANCE_XLM,
  submitTransaction,
  truncateMemoText,
} from "@/lib/stellar";
import { signTransactionWithWallet } from "@/lib/wallet";
import { formatXLMPrecise, parseBatchRecipientsCSV } from "@/utils/format";

const MAX_RECIPIENTS = 10;

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
  const canSubmit =
    !isProcessing &&
    recipients.some(
      (recipient) =>
        isValidStellarAddress(recipient.address) &&
        parseFloat(recipient.amount) > 0 &&
        recipient.address !== publicKey
    );
  const exceedsBalance = totalXLM > availableXLM;

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

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setImportMessage(null);

    try {
      importRecipientsFromCSV(await readFileAsText(file));
    } catch (err: unknown) {
      setImportMessage(
        err instanceof Error ? err.message : "Could not read the selected file."
      );
    }
  };

  const validateRecipient = (recipient: BatchRecipient) => {
    const amount = parseFloat(recipient.amount);
    if (!isValidStellarAddress(recipient.address)) {
      return "Invalid Stellar address.";
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return "Amount must be greater than 0.";
    }
    if (recipient.address === publicKey) {
      return "Recipient address cannot be the same as your wallet.";
    }
    return null;
  };

  const processRows = async (retryOnlyFailed = false) => {
    setBatchMessage(null);
    setIsProcessing(true);

    let nextRecipients = recipients.map((recipient) => ({ ...recipient }));
    setRecipients(nextRecipients);

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < nextRecipients.length; i++) {
      const recipient = nextRecipients[i];
      if (recipient.status === "success") {
        successCount++;
        continue;
      }
      if (retryOnlyFailed && recipient.status !== "failed") {
        continue;
      }

      const validationError = validateRecipient(recipient);
      if (validationError) {
        nextRecipients[i] = {
          ...recipient,
          status: "failed",
          error: validationError,
        };
        setRecipients([...nextRecipients]);
        failCount++;
        continue;
      }

      nextRecipients[i] = { ...recipient, status: "pending", error: undefined };
      setRecipients([...nextRecipients]);

      try {
        const tx = await buildPaymentTransaction({
          sourcePublicKey: publicKey,
          destinationPublicKey: recipient.address,
          amount: recipient.amount,
          memo: recipient.memo || undefined,
        });

        const signResult = await signTransactionWithWallet(tx.toXDR(), publicKey);
        if (signResult.error || !signResult.signedXDR) {
          throw new Error(signResult.error || "Failed to sign transaction with wallet.");
        }

        const submitResult = await submitTransaction(signResult.signedXDR);
        nextRecipients[i] = {
          ...nextRecipients[i],
          status: "success",
          transactionHash: submitResult.hash,
          error: undefined,
        };
        successCount++;
      } catch (err: unknown) {
        nextRecipients[i] = {
          ...nextRecipients[i],
          status: "failed",
          error: err instanceof Error ? err.message : "Transaction failed.",
        };
        failCount++;
      }

      setRecipients([...nextRecipients]);
    }

    setIsProcessing(false);

    if (failCount === 0 && successCount > 0) {
      setBatchMessage(`Successfully sent batch to ${successCount} recipient${successCount === 1 ? "" : "s"}!`);
      onBatchSuccess?.();
    } else if (failCount > 0 && successCount > 0) {
      setBatchMessage(`Partial batch result: ${successCount} succeeded, ${failCount} failed. Fix errors and retry failed operations.`);
    } else if (failCount > 0) {
      setBatchMessage(`Batch failed for ${failCount} recipient${failCount === 1 ? "" : "s"}. Please review errors and retry.`);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    processRows(false);
  };

  const handleRetryFailed = () => {
    processRows(true);
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Batch Payments</h2>
          <p className="text-sm text-gray-500">
            Send Stellar native payments to up to {MAX_RECIPIENTS} recipients in sequence.
          </p>
        </div>
        <div className="text-right">
          <span className="text-sm font-medium text-gray-700">
            {recipients.length} / {MAX_RECIPIENTS}
          </span>
        </div>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleImportFile}
          accept=".csv,text/csv"
          className="hidden"
          id="csv-file-input"
          aria-label="Import recipients from CSV"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isProcessing}
          className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg border border-gray-300 disabled:opacity-50"
        >
          Import CSV
        </button>
        {importMessage && (
          <p className="text-xs text-gray-600 flex-1" role="status">
            {importMessage}
          </p>
        )}
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {recipients.map((recipient, index) => {
          const isSuccess = recipient.status === "success";
          const isPending = recipient.status === "pending";
          const isFailed = recipient.status === "failed";

          return (
            <div
              key={recipient.id}
              className={`p-4 rounded-xl border transition-colors ${
                isSuccess
                  ? "bg-green-50/50 border-green-200"
                  : isFailed
                    ? "bg-red-50/50 border-red-200"
                    : "bg-gray-50/50 border-gray-200"
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                  Recipient #{index + 1}
                </span>
                <div className="flex items-center gap-2">
                  {isSuccess && (
                    <span className="text-xs font-medium text-green-700 bg-green-100 px-2 py-0.5 rounded">
                      Confirmed {recipient.transactionHash ? `(${recipient.transactionHash.slice(0, 6)}...)` : ""}
                    </span>
                  )}
                  {isPending && (
                    <span className="text-xs font-medium text-amber-700 bg-amber-100 px-2 py-0.5 rounded animate-pulse">
                      Processing...
                    </span>
                  )}
                  {isFailed && (
                    <span className="text-xs font-medium text-red-700 bg-red-100 px-2 py-0.5 rounded">
                      Failed
                    </span>
                  )}
                  {recipients.length > 1 && !isProcessing && !isPending && !isSuccess && (
                    <button
                      type="button"
                      onClick={() => handleRemoveRecipient(recipient.id)}
                      className="text-xs text-red-600 hover:text-red-800 font-medium"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                <div className="md:col-span-6">
                  <input
                    type="text"
                    placeholder="G..."
                    value={recipient.address}
                    disabled={isProcessing || isSuccess}
                    onChange={(e) => updateRecipient(recipient.id, { address: e.target.value.trim(), status: "idle", error: undefined })}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                  />
                </div>
                <div className="md:col-span-3">
                  <input
                    type="number"
                    step="0.0000001"
                    min="0"
                    placeholder="0.5"
                    value={recipient.amount}
                    disabled={isProcessing || isSuccess}
                    onChange={(e) => updateRecipient(recipient.id, { amount: e.target.value, status: "idle", error: undefined })}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                  />
                </div>
                <div className="md:col-span-3">
                  <input
                    type="text"
                    placeholder="Memo (opt)"
                    maxLength={STELLAR_MEMO_TEXT_MAX_BYTES}
                    value={recipient.memo}
                    disabled={isProcessing || isSuccess}
                    onChange={(e) => updateRecipient(recipient.id, { memo: truncateMemoText(e.target.value), status: "idle", error: undefined })}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                  />
                </div>
              </div>

              {recipient.error && (
                <p className="mt-2 text-xs text-red-600 font-medium" role="alert">
                  {recipient.error}
                </p>
              )}
            </div>
          );
        })}

        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            onClick={handleAddRecipient}
            disabled={isProcessing || recipients.length >= MAX_RECIPIENTS}
            className="px-4 py-2 text-sm font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50"
          >
            + Add recipient
          </button>

          <div className="text-right">
            <span className="text-sm text-gray-600 mr-4">
              Total: <strong className="text-gray-900">{formatXLMPrecise(totalXLM)} XLM</strong>
            </span>
          </div>
        </div>

        {exceedsBalance && (
          <p className="text-xs text-red-600 font-medium" role="alert">
            Total batch amount exceeds available balance ({formatXLMPrecise(availableXLM)} XLM).
          </p>
        )}

        {batchMessage && (
          <div className={`p-3 rounded-lg text-sm ${hasFailed && hasSuccess ? "bg-amber-50 text-amber-800 border border-amber-200" : hasFailed ? "bg-red-50 text-red-800 border border-red-200" : "bg-green-50 text-green-800 border border-green-200"}`} role="status">
            {batchMessage}
          </div>
        )}

        <div className="flex gap-3 pt-4">
          <button
            type="submit"
            disabled={!canSubmit || exceedsBalance || isProcessing}
            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 px-4 rounded-xl transition-colors disabled:opacity-50"
          >
            {isProcessing ? "Processing Batch..." : "Send batch"}
          </button>

          {hasFailed && !isProcessing && (
            <button
              type="button"
              onClick={handleRetryFailed}
              className="bg-amber-600 hover:bg-amber-700 text-white font-medium py-2.5 px-4 rounded-xl transition-colors"
            >
              Retry failed only
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
