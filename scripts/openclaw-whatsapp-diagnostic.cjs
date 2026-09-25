const fs = require("fs");

const execPath = "src/infra/outbound/deliver-queue-execute.ts";
const queuePath = "src/infra/outbound/deliver-queue.ts";

for (const p of [execPath, queuePath]) {
  if (!fs.existsSync(p)) {
    throw new Error(`WhatsApp delivery diagnostic target missing: ${p}`);
  }
}

let execSource = fs.readFileSync(execPath, "utf8");
if (!execSource.includes("[whatsapp-live-delivery-diagnostic]")) {
  const needle = `  } catch (caughtError) {
    let err = caughtError;`;
  const replacement = `  } catch (caughtError) {
    if (params.channel === "whatsapp") {
      const diagnosticError =
        caughtError instanceof Error ? caughtError : new Error(formatErrorMessage(caughtError));
      const diagnosticCode =
        typeof caughtError === "object" &&
        caughtError !== null &&
        "code" in caughtError
          ? String((caughtError as { code?: unknown }).code ?? "")
          : "";
      log.warn(
        \\`[whatsapp-live-delivery-diagnostic] queueId=\\${queueId ?? "none"} producerClaim=\\${producerClaimId ? "present" : "missing"} custody=\\${queueOwner?.custody ?? "none"} platformSendStarted=\\${platformSendStarted} preSend=\\${queuedPreSendState ?? "none"} postSend=\\${queuedPostSendState ?? "none"} results=\\${deliveredResults.length} aborted=\\${Boolean(params.abortSignal?.aborted)} errorName=\\${diagnosticError.name} errorCode=\\${diagnosticCode || "none"} error=\\${formatErrorMessage(caughtError)}\\`,
      );
    }
    let err = caughtError;`;
  if (!execSource.includes(needle)) {
    throw new Error("deliver-queue-execute diagnostic insertion point not found");
  }
  execSource = execSource.replace(needle, replacement);
  fs.writeFileSync(execPath, execSource);
}

let queueSource = fs.readFileSync(queuePath, "utf8");
if (!queueSource.includes("[whatsapp-queue-handoff-diagnostic]")) {
  const needle = `  } catch (error) {
    throw queueOwner ? queueOwner.project(error) : error;
  }
}`;
  const replacement = `  } catch (error) {
    if (channel === "whatsapp") {
      log.warn(
        \\`[whatsapp-queue-handoff-diagnostic] queueId=\\${queueId ?? "none"} created=\\${queued?.created === true} producerClaim=\\${queued?.producerClaimId ? "present" : "missing"} custody=\\${queueOwner?.custody ?? "none"} reusePending=\\${Boolean(params.reusePendingDeliveryIntent)} stableClaim=\\${stableIntentClaimHeld} aborted=\\${Boolean(params.abortSignal?.aborted)} error=\\${formatErrorMessage(error)}\\`,
      );
    }
    throw queueOwner ? queueOwner.project(error) : error;
  }
}`;
  const idx = queueSource.lastIndexOf(needle);
  if (idx < 0) {
    throw new Error("deliver-queue diagnostic insertion point not found");
  }
  queueSource = queueSource.slice(0, idx) + replacement + queueSource.slice(idx + needle.length);
  fs.writeFileSync(queuePath, queueSource);
}
