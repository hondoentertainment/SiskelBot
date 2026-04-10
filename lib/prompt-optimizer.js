/**
 * Prompt optimization through feedback analysis.
 * Correlates user feedback ratings with system prompts, models, tools, and response patterns
 * to generate actionable improvement suggestions.
 */
import { getFeedbackStats, listFeedback } from "./feedback.js";

/**
 * Analyze prompt performance by correlating feedback ratings with various dimensions.
 * @param {string} workspaceId
 * @returns {Promise<{ insights: Array<{ type: string, finding: string, confidence: number }> }>}
 */
export async function analyzePromptPerformance(workspaceId) {
  const items = await listFeedback(workspaceId || "default");
  const insights = [];

  if (items.length < 3) {
    return { insights: [{ type: "insufficient_data", finding: "Not enough feedback to analyze (minimum 3 entries required).", confidence: 1 }] };
  }

  // Insight 1: Model performance comparison
  const modelStats = {};
  for (const item of items) {
    const model = item.model || "unknown";
    if (!modelStats[model]) modelStats[model] = { ratings: [], responseLengths: [] };
    modelStats[model].ratings.push(item.rating);
    if (item.response) modelStats[model].responseLengths.push(item.response.length);
  }

  const modelEntries = Object.entries(modelStats).filter(([, s]) => s.ratings.length >= 2);
  if (modelEntries.length >= 2) {
    const ranked = modelEntries
      .map(([model, s]) => ({
        model,
        avg: s.ratings.reduce((a, b) => a + b, 0) / s.ratings.length,
        count: s.ratings.length,
      }))
      .sort((a, b) => b.avg - a.avg);

    const best = ranked[0];
    const worst = ranked[ranked.length - 1];
    if (best.avg - worst.avg >= 0.5) {
      insights.push({
        type: "model_comparison",
        finding: `Model "${best.model}" (avg ${best.avg.toFixed(2)}, n=${best.count}) outperforms "${worst.model}" (avg ${worst.avg.toFixed(2)}, n=${worst.count}).`,
        confidence: Math.min(0.95, 0.5 + Math.min(best.count, worst.count) * 0.05),
      });
    }
  }

  // Insight 2: Response length correlation
  const withResponses = items.filter((i) => i.response);
  if (withResponses.length >= 5) {
    const short = withResponses.filter((i) => i.response.length < 500);
    const medium = withResponses.filter((i) => i.response.length >= 500 && i.response.length < 2000);
    const long = withResponses.filter((i) => i.response.length >= 2000);

    const avgShort = short.length ? short.reduce((s, i) => s + i.rating, 0) / short.length : 0;
    const avgMedium = medium.length ? medium.reduce((s, i) => s + i.rating, 0) / medium.length : 0;
    const avgLong = long.length ? long.reduce((s, i) => s + i.rating, 0) / long.length : 0;

    const lengths = [
      { label: "short (<500 chars)", avg: avgShort, count: short.length },
      { label: "medium (500-2000 chars)", avg: avgMedium, count: medium.length },
      { label: "long (>2000 chars)", avg: avgLong, count: long.length },
    ].filter((l) => l.count >= 2);

    if (lengths.length >= 2) {
      const bestLen = lengths.reduce((a, b) => (a.avg > b.avg ? a : b));
      insights.push({
        type: "response_length",
        finding: `Responses of ${bestLen.label} length are rated highest (avg ${bestLen.avg.toFixed(2)}, n=${bestLen.count}).`,
        confidence: Math.min(0.85, 0.4 + bestLen.count * 0.05),
      });
    }
  }

  // Insight 3: Rating trend over time
  const sorted = [...items].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (sorted.length >= 6) {
    const half = Math.floor(sorted.length / 2);
    const firstHalf = sorted.slice(0, half);
    const secondHalf = sorted.slice(half);
    const avgFirst = firstHalf.reduce((s, i) => s + i.rating, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((s, i) => s + i.rating, 0) / secondHalf.length;
    const diff = avgSecond - avgFirst;

    if (Math.abs(diff) >= 0.3) {
      const direction = diff > 0 ? "improving" : "declining";
      insights.push({
        type: "rating_trend",
        finding: `Rating trend is ${direction}: first half avg ${avgFirst.toFixed(2)} vs second half avg ${avgSecond.toFixed(2)}.`,
        confidence: Math.min(0.8, 0.4 + sorted.length * 0.02),
      });
    }
  }

  // Insight 4: Low-rated response patterns
  const lowRated = items.filter((i) => i.rating <= 2 && i.response);
  const highRated = items.filter((i) => i.rating >= 4 && i.response);
  if (lowRated.length >= 2 && highRated.length >= 2) {
    const avgLowLen = lowRated.reduce((s, i) => s + i.response.length, 0) / lowRated.length;
    const avgHighLen = highRated.reduce((s, i) => s + i.response.length, 0) / highRated.length;

    if (Math.abs(avgHighLen - avgLowLen) > 200) {
      const preferred = avgHighLen > avgLowLen ? "longer" : "shorter";
      insights.push({
        type: "length_preference",
        finding: `Users prefer ${preferred} responses: high-rated avg ${Math.round(avgHighLen)} chars vs low-rated avg ${Math.round(avgLowLen)} chars.`,
        confidence: Math.min(0.8, 0.4 + Math.min(lowRated.length, highRated.length) * 0.05),
      });
    }
  }

  // Insight 5: Overall satisfaction
  const overallAvg = items.reduce((s, i) => s + i.rating, 0) / items.length;
  if (overallAvg < 3.0) {
    insights.push({
      type: "low_satisfaction",
      finding: `Overall satisfaction is low (avg ${overallAvg.toFixed(2)} across ${items.length} ratings). Consider reviewing system prompts and model selection.`,
      confidence: Math.min(0.9, 0.5 + items.length * 0.02),
    });
  } else if (overallAvg >= 4.0) {
    insights.push({
      type: "high_satisfaction",
      finding: `Overall satisfaction is high (avg ${overallAvg.toFixed(2)} across ${items.length} ratings).`,
      confidence: Math.min(0.9, 0.5 + items.length * 0.02),
    });
  }

  if (insights.length === 0) {
    insights.push({
      type: "no_significant_patterns",
      finding: "No significant patterns detected. More feedback data may reveal trends.",
      confidence: 0.5,
    });
  }

  return { insights };
}

/**
 * Suggest system prompt improvements based on low-rated responses.
 * @param {string} workspaceId
 * @returns {Promise<{ suggestions: Array<{ area: string, current: string, suggested: string, reasoning: string }> }>}
 */
export async function suggestPromptImprovements(workspaceId) {
  const items = await listFeedback(workspaceId || "default");
  const suggestions = [];

  if (items.length < 3) {
    return { suggestions: [{ area: "data", current: "N/A", suggested: "Collect more feedback", reasoning: "At least 3 feedback entries are needed for analysis." }] };
  }

  const lowRated = items.filter((i) => i.rating <= 2);
  const highRated = items.filter((i) => i.rating >= 4);

  // Suggestion 1: Response length tuning
  const lowWithResp = lowRated.filter((i) => i.response);
  const highWithResp = highRated.filter((i) => i.response);
  if (lowWithResp.length >= 2 && highWithResp.length >= 2) {
    const avgLowLen = lowWithResp.reduce((s, i) => s + i.response.length, 0) / lowWithResp.length;
    const avgHighLen = highWithResp.reduce((s, i) => s + i.response.length, 0) / highWithResp.length;

    if (avgHighLen > avgLowLen * 1.5) {
      suggestions.push({
        area: "response_length",
        current: "No specific length guidance in system prompt",
        suggested: "Add instruction: Provide detailed, thorough responses with examples when appropriate.",
        reasoning: `High-rated responses average ${Math.round(avgHighLen)} chars vs ${Math.round(avgLowLen)} chars for low-rated. Users prefer more detailed answers.`,
      });
    } else if (avgLowLen > avgHighLen * 1.5) {
      suggestions.push({
        area: "response_length",
        current: "No specific length guidance in system prompt",
        suggested: "Add instruction: Be concise and direct. Avoid unnecessary elaboration.",
        reasoning: `Low-rated responses average ${Math.round(avgLowLen)} chars vs ${Math.round(avgHighLen)} chars for high-rated. Users prefer concise answers.`,
      });
    }
  }

  // Suggestion 2: Model selection
  const modelStats = {};
  for (const item of items) {
    const model = item.model || "unknown";
    if (!modelStats[model]) modelStats[model] = { ratings: [], count: 0 };
    modelStats[model].ratings.push(item.rating);
    modelStats[model].count += 1;
  }

  const modelEntries = Object.entries(modelStats).filter(([, s]) => s.count >= 3);
  if (modelEntries.length >= 2) {
    const ranked = modelEntries
      .map(([model, s]) => ({
        model,
        avg: s.ratings.reduce((a, b) => a + b, 0) / s.ratings.length,
        count: s.count,
      }))
      .sort((a, b) => b.avg - a.avg);

    const best = ranked[0];
    const worst = ranked[ranked.length - 1];
    if (best.avg - worst.avg >= 1.0) {
      suggestions.push({
        area: "model_selection",
        current: `Using multiple models including "${worst.model}"`,
        suggested: `Prefer "${best.model}" as the default model`,
        reasoning: `"${best.model}" scores ${best.avg.toFixed(1)} avg vs "${worst.model}" at ${worst.avg.toFixed(1)} avg across ${best.count}+ samples each.`,
      });
    }
  }

  // Suggestion 3: Common complaints from comments
  const lowComments = lowRated.filter((i) => i.comment).map((i) => i.comment.toLowerCase());
  if (lowComments.length >= 2) {
    const keywords = {
      accuracy: ["wrong", "incorrect", "inaccurate", "mistake", "error", "hallucin"],
      relevance: ["irrelevant", "off-topic", "not what i asked", "didn't answer", "unrelated"],
      clarity: ["confusing", "unclear", "hard to understand", "vague", "ambiguous"],
      completeness: ["incomplete", "missing", "didn't finish", "partial", "not enough"],
    };

    for (const [area, terms] of Object.entries(keywords)) {
      const matches = lowComments.filter((c) => terms.some((t) => c.includes(t)));
      if (matches.length >= 2) {
        const promptFixes = {
          accuracy: "Add instruction: Double-check facts before responding. If uncertain, state your confidence level.",
          relevance: "Add instruction: Focus strictly on answering the user's question. Ask for clarification if the question is ambiguous.",
          clarity: "Add instruction: Structure responses with clear headings, bullet points, and step-by-step explanations.",
          completeness: "Add instruction: Provide complete answers covering all aspects of the question. Include examples when helpful.",
        };
        suggestions.push({
          area,
          current: "No specific guidance on " + area,
          suggested: promptFixes[area],
          reasoning: `${matches.length} low-rated responses mention ${area}-related issues.`,
        });
      }
    }
  }

  if (suggestions.length === 0) {
    suggestions.push({
      area: "general",
      current: "Current configuration",
      suggested: "No specific improvements identified",
      reasoning: "Feedback patterns don't indicate clear areas for improvement. Continue collecting data.",
    });
  }

  return { suggestions };
}

/**
 * Compare A/B test results using feedback data.
 * @param {string} workspaceId
 * @returns {Promise<{ modelA: { model: string, avgRating: number, samples: number } | null, modelB: { model: string, avgRating: number, samples: number } | null, winner: string | null, significant: boolean }>}
 */
export async function getABTestResults(workspaceId) {
  const items = await listFeedback(workspaceId || "default");

  const modelStats = {};
  for (const item of items) {
    const model = item.model || "unknown";
    if (!modelStats[model]) modelStats[model] = { ratings: [], count: 0 };
    modelStats[model].ratings.push(item.rating);
    modelStats[model].count += 1;
  }

  const models = Object.entries(modelStats)
    .filter(([, s]) => s.count >= 2)
    .map(([model, s]) => ({
      model,
      avgRating: Math.round((s.ratings.reduce((a, b) => a + b, 0) / s.ratings.length) * 100) / 100,
      samples: s.count,
    }))
    .sort((a, b) => b.avgRating - a.avgRating);

  if (models.length < 2) {
    return { modelA: models[0] || null, modelB: null, winner: null, significant: false };
  }

  const modelA = models[0];
  const modelB = models[1];

  // Simple significance check: enough samples and meaningful difference
  const minSamples = Math.min(modelA.samples, modelB.samples);
  const diff = Math.abs(modelA.avgRating - modelB.avgRating);
  const significant = minSamples >= 10 && diff >= 0.5;

  const winner = significant ? modelA.model : null;

  return { modelA, modelB, winner, significant };
}
