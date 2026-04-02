    const runBtn = document.getElementById("runBtn");
    const evalSetSelect = document.getElementById("evalSet");
    const apiKeyInput = document.getElementById("apiKey");
    const resultsSection = document.getElementById("resultsSection");
    const resultsSummary = document.getElementById("resultsSummary");
    const resultsBody = document.getElementById("resultsBody");

    async function loadSets() {
      try {
        const key = apiKeyInput.value.trim();
        const headers = key ? { "x-api-key": key } : {};
        const r = await fetch("/api/eval/sets", { headers });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          evalSetSelect.innerHTML = `<option value="">${err.error || "Failed to load"}</option>`;
          return;
        }
        const { sets } = await r.json();
        evalSetSelect.innerHTML = sets.length
          ? sets.map((s) => `<option value="${s.id}">${s.name || s.id}</option>`).join("")
          : '<option value="">No eval sets found</option>';
      } catch (e) {
        evalSetSelect.innerHTML = `<option value="">Error: ${e.message}</option>`;
      }
    }

    document.getElementById("apiKey").addEventListener("blur", loadSets);
    loadSets();

    runBtn.addEventListener("click", async () => {
      const setId = evalSetSelect.value;
      if (!setId) {
        alert("Select an eval set first.");
        return;
      }
      const key = apiKeyInput.value.trim();
      if (!key) {
        const r = await fetch("/api/eval/sets");
        if (r.status === 401) {
          alert("API key required. Set ADMIN_API_KEY or API_KEY and enter it above.");
          return;
        }
      }
      runBtn.disabled = true;
      try {
        const headers = {
          "Content-Type": "application/json",
          ...(key && { "x-api-key": key }),
        };
        const r = await fetch("/api/eval/run", {
          method: "POST",
          headers,
          body: JSON.stringify({ evalSetId: setId }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          resultsSection.style.display = "block";
          resultsSummary.textContent = `Error: ${data.error || r.statusText}`;
          resultsBody.innerHTML = "";
          return;
        }
        const { results, passed, total, durationMs, skipped } = data;
        const skipCount =
          typeof skipped === "number"
            ? skipped
            : results.filter((r) => r.skipped).length;
        const skipNote =
          skipCount > 0 ? ` — <strong>${skipCount}</strong> skipped (not run)` : "";
        resultsSummary.innerHTML = `<strong>${passed}</strong> passed of <strong>${total}</strong> cases in ${durationMs}ms${skipNote}`;
        resultsBody.innerHTML = results
          .map((res) => {
            let resultCell;
            if (res.skipped) {
              resultCell = `<td class="skip">skipped</td>`;
            } else {
              resultCell = `<td class="${res.pass ? "pass" : "fail"}">${res.pass ? "✓" : "✗"}</td>`;
            }
            return `<tr>
                <td>${escapeHtml(String(res.caseId || ""))}</td>
                ${resultCell}
                <td class="output-cell">${escapeHtml((res.output || "").slice(0, 200))}</td>
                <td class="activity-cell">${escapeHtml((res.agentActivityHint || "").slice(0, 200))}</td>
                <td class="error-msg">${escapeHtml(res.error || res.reason || "")}</td>
              </tr>`;
          })
          .join("");
        resultsSection.style.display = "block";
      } catch (e) {
        resultsSection.style.display = "block";
        resultsSummary.textContent = `Error: ${e.message}`;
        resultsBody.innerHTML = "";
      } finally {
        runBtn.disabled = false;
      }
    });

    function escapeHtml(s) {
      const div = document.createElement("div");
      div.textContent = s;
      return div.innerHTML;
    }
