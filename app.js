const state = {
  data: null,
  activeView: "workbench",
  spectrumMode: "stacked",
  reportStatus: "待复核",
  uploadedSpectrum: null,
  importResult: null,
  selectedSpectrumIndex: 0,
  sampleInterpretation: null,
  analysisSubstances: null,
  analysisRequest: null,
  analysisResponse: null,
  analysisBackend: "ASFN单光谱分析适配层",
  sampleEdits: {
    note: "",
    operator: "未填写",
    reviewer: "未填写",
  },
  analysisHistory: [],
  importError: null,
  qc: null,
  pipeline: {
    imported: false,
    qc: false,
    analyzed: false,
    reported: false,
  },
};

const colors = {
  Trp: "#1f77b4",
  Phe: "#d88327",
  Glc: "#1f9b90",
  CRP: "#be4b4b",
  RSTN: "#7652a6",
  APN: "#4f6f7f",
};

const substanceMeta = {
  Trp: { name: "色氨酸", aliases: ["trp", "tryptophan", "色氨酸"] },
  Phe: { name: "苯丙氨酸", aliases: ["phe", "phenylalanine", "苯丙氨酸"] },
  Glc: { name: "葡萄糖", aliases: ["glc", "glu", "glucose", "葡萄糖"] },
  CRP: { name: "C反应蛋白", aliases: ["crp", "c反应蛋白", "c-reactive"] },
  RSTN: { name: "抵抗素", aliases: ["rstn", "resistin", "抵抗素"] },
  APN: { name: "脂联素", aliases: ["apn", "adiponectin", "脂联素"] },
};

const panelSubstances = Object.keys(substanceMeta);

const statusClass = {
  常规范围: "status-normal",
  建议关注: "status-watch",
  需复核: "status-review",
};

const levelClass = {
  normal: "level-normal",
  watch: "level-watch",
  review: "level-review",
};

const pipelineLabels = [
  ["imported", "光谱导入"],
  ["qc", "自动质控"],
  ["analyzed", "ASFN分析"],
  ["reported", "报告生成"],
];

function el(selector) {
  return document.querySelector(selector);
}

function els(selector) {
  return [...document.querySelectorAll(selector)];
}

function pct(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function fmt(value, digits = 3) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits).replace(/\.?0+$/, "") : "--";
}

function createStatusPill(status) {
  return `<span class="status-pill ${statusClass[status] || ""}">${status}</span>`;
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cloneData(data) {
  return JSON.parse(JSON.stringify(data));
}

function createRequestId() {
  const time = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `ASFN-${time}-${Math.floor(Math.random() * 900 + 100)}`;
}

function createReportId() {
  const time = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `RPT-${time}-${Math.floor(Math.random() * 900 + 100)}`;
}

function detectMarkerFromText(text = "") {
  const source = String(text).toLowerCase();
  for (const [abbr, meta] of Object.entries(substanceMeta)) {
    if (meta.aliases.some((alias) => source.includes(alias.toLowerCase()))) return abbr;
  }
  return null;
}

function interpolateSpectrum(points, axis) {
  if (!points?.length || !axis?.length) return [];
  const sorted = [...points].sort((a, b) => a.wavenumber - b.wavenumber);
  let j = 0;
  return axis.map((wn) => {
    while (j < sorted.length - 2 && sorted[j + 1].wavenumber < wn) j += 1;
    const left = sorted[j];
    const right = sorted[Math.min(j + 1, sorted.length - 1)];
    if (!left || !right) return 0;
    if (wn <= left.wavenumber) return left.intensity;
    if (wn >= right.wavenumber && j >= sorted.length - 2) return right.intensity;
    const span = right.wavenumber - left.wavenumber || 1;
    const t = (wn - left.wavenumber) / span;
    return left.intensity + (right.intensity - left.intensity) * t;
  });
}

function zScore(values) {
  const mean = values.reduce((acc, value) => acc + value, 0) / values.length;
  const variance = values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / values.length;
  const sd = Math.sqrt(variance) || 1;
  return values.map((value) => (value - mean) / sd);
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    aa += a[i] ** 2;
    bb += b[i] ** 2;
  }
  return dot / (Math.sqrt(aa * bb) || 1);
}

function buildReferenceTemplates(data) {
  const axis = data.spectra.map((row) => row.wavenumber);
  const templates = {};
  panelSubstances.forEach((abbr) => {
    templates[abbr] = zScore(data.spectra.map((row) => Number(row[abbr]) || 0));
  });
  return { axis, templates };
}

function classifySpectrum(candidate, data) {
  if (!candidate?.points?.length || !data?.spectra?.length) return null;
  const { axis, templates } = buildReferenceTemplates(data);
  const input = zScore(interpolateSpectrum(candidate.points, axis));
  const rawScores = panelSubstances
    .map((abbr) => {
      const corr = pearson(input, templates[abbr]);
      const normalized = (corr + 1) / 2;
      return {
        marker: abbr,
        name: substanceMeta[abbr].name,
        similarity: Number(normalized.toFixed(4)),
        correlation: Number(corr.toFixed(4)),
      };
    })
    .sort((a, b) => b.similarity - a.similarity);
  const top = rawScores[0];
  const second = rawScores[1];
  if (!top) return null;
  const sum = rawScores.reduce((acc, row) => acc + Math.max(row.similarity, 0.001), 0) || 1;
  const confidence = Math.max(0, Math.min(0.995, top.similarity - Math.max(0, 0.12 - (top.similarity - (second?.similarity || 0))) * 0.25));
  return {
    marker: top.marker,
    name: top.name,
    confidence: Number(confidence.toFixed(4)),
    margin: Number((top.similarity - (second?.similarity || 0)).toFixed(4)),
    scores: rawScores,
  };
}

function decorateImportResult(importResult) {
  const candidates = importResult.candidates.map((candidate) => {
    const markerHint = detectMarkerFromText(`${candidate.name} ${candidate.sourceMeta?.fileName || ""}`);
    const spectralPrediction = classifySpectrum(candidate, state.rawData);
    return {
      ...candidate,
      markerHint: markerHint || spectralPrediction?.marker || null,
      textMarkerHint: markerHint,
      spectralPrediction,
    };
  });
  return { ...importResult, candidates };
}

function inferSampleInterpretation(importResult, selectedIndex = state.selectedSpectrumIndex) {
  if (!importResult?.candidates?.length) {
    return {
      type: "empty",
      modeLabel: "等待光谱",
      sampleTypeLabel: "未导入样本",
      substances: [],
      completePanel: false,
      reportHint: "请先导入待分析光谱文件。",
    };
  }

  const selected = importResult.candidates[selectedIndex] || importResult.candidates[0];
  const prediction = selected?.spectralPrediction;
  const confidence = prediction?.confidence || 0;
  const margin = prediction?.margin || 0;
  const reliable = prediction?.marker && confidence >= 0.42 && margin >= 0.035;

  if (reliable) {
    const abbr = prediction.marker;
    return {
      type: "single_asfn",
      modeLabel: "单光谱定性+定量",
      sampleTypeLabel: `${substanceMeta[abbr].name}光谱`,
      substances: [abbr],
      completePanel: false,
      predictedMarker: abbr,
      confidence,
      margin,
      reportHint: `系统识别为${substanceMeta[abbr].name}，将仅输出该标志物的浓度预测结果。`,
    };
  }

  return {
    type: "unknown",
    modeLabel: "识别置信度不足",
    sampleTypeLabel: "未知光谱",
    substances: [],
    completePanel: false,
    predictedMarker: prediction?.marker || null,
    confidence,
    margin,
      reportHint: prediction?.marker
      ? `当前光谱最接近${substanceMeta[prediction.marker].name}，但识别置信度不足，暂不输出浓度结果。`
      : "未能确认检测对象，建议补充样本信息或重新采集光谱后再分析。",
  };
}

function setInterpretation(importResult = state.importResult, selectedIndex = state.selectedSpectrumIndex) {
  state.sampleInterpretation = inferSampleInterpretation(importResult, selectedIndex);
  state.analysisSubstances = state.sampleInterpretation.substances;
  return state.sampleInterpretation;
}

function buildAsfnAnalysisRequest() {
  const interpretation = state.sampleInterpretation || setInterpretation();
  const selected = state.uploadedSpectrum;
  const channels = selected && interpretation.substances.length
    ? [{
          marker: interpretation.substances[0],
          name: selected.name,
          points: selected.points.length,
          range: selected.range,
          confidence: interpretation.confidence,
          similarityRanking: selected.spectralPrediction?.scores || [],
        }]
      : [];

  return {
    requestId: createRequestId(),
    createdAt: new Date().toISOString(),
    sampleId: selected?.sampleId || "SERS-UPLOAD",
    sampleType: interpretation.sampleTypeLabel,
    analysisMode: interpretation.type,
    backend: state.analysisBackend,
    channels,
    qc: state.qc,
    inputPolicy: {
      requireConfirmedChannel: true,
      completePanel: false,
      outputMarkers: interpretation.substances,
    },
  };
}

function createAsfnAnalysisResponse(request, baseData, qc) {
  const allowed = new Set(request.inputPolicy.outputMarkers || []);
  if (!request.channels.length || !allowed.size) {
    return {
      requestId: request.requestId,
      backend: request.backend,
      status: "channel_required",
      generatedAt: new Date().toISOString(),
      predictions: [],
      message: "未达到可靠识别阈值，未生成标志物浓度结果。",
    };
  }

  const qualityFactor = Math.max(0.88, Math.min(1.05, qc.overall / 92));
  const spectralFactor = Math.max(0.9, Math.min(1.1, 1 + (qc.signalSpan - 1.2) * 0.035));
  const sourceRows = baseData.substances.filter((substance) => allowed.has(substance.abbr));
  const predictions = sourceRows.map((substance, index) => {
    const classificationConfidence = request.channels.find((channel) => channel.marker === substance.abbr)?.confidence || 0;
    const confidenceFactor = Math.max(0.94, Math.min(1.04, 0.98 + classificationConfidence * 0.04));
    const predicted = Number((substance.indicator.predicted * qualityFactor * spectralFactor * confidenceFactor).toFixed(3));
    return {
      marker: substance.abbr,
      name: substance.name,
      predicted,
      unit: substance.indicator.unit,
      reference: substance.indicator.reference,
      sd: Number((Math.max(substance.indicator.sd * (1.05 - qc.overall / 220), 0.01)).toFixed(3)),
      r2: substance.regression.r2,
      f1: substance.classification.f1,
      classificationConfidence,
      nSpectra: request.channels.find((channel) => channel.marker === substance.abbr)?.points || state.uploadedSpectrum?.points.length || 0,
    };
  });

  return {
    requestId: request.requestId,
    backend: request.backend,
    status: "completed",
    generatedAt: new Date().toISOString(),
    predictions,
    message: "已完成单光谱定性识别与对应标志物浓度预测。",
    evidence: {
      basis: "前期ASFN模型结果、糖尿病标志物平均SERS模板和当前光谱质控评分",
      onlineModelWeights: false,
      note: "当前网页端未部署深度学习权重文件，结果用于科研辅助展示和复核。",
    },
  };
}

function updateSampleFromSpectrum(data, spectrum) {
  if (!spectrum) return;
  const interpretation = state.sampleInterpretation || setInterpretation();
  if (!state.sampleEdits.reportId) state.sampleEdits.reportId = createReportId();
  data.sample.id = state.sampleEdits.id || spectrum.sampleId;
  data.sample.batch = state.sampleEdits.batch || "DM-SERS-UPLOAD";
  data.sample.type = state.sampleEdits.type || interpretation.sampleTypeLabel || "上传光谱";
  data.sample.spectraCount = spectrum.points.length;
  data.sample.waveRange = `${Math.round(spectrum.range[0])}-${Math.round(spectrum.range[1])} cm⁻¹`;
  data.sample.analyzedAt = new Date().toLocaleString("zh-CN", { hour12: false });
  data.sample.status = state.pipeline.analyzed ? "分析完成" : "待分析";
  data.sample.reportStatus = state.reportStatus;
  data.sample.note = state.sampleEdits.note || "";
  data.sample.reportId = state.sampleEdits.reportId;
  data.sample.operator = state.sampleEdits.operator || "未填写";
  data.sample.reviewer = state.sampleEdits.reviewer || "未填写";
}

function applyAnalysisResponse(baseData, spectrum, response) {
  const data = cloneData(baseData);
  updateSampleFromSpectrum(data, spectrum);
  if (!spectrum || !response?.predictions?.length) {
    data.substances = [];
    data.summary.normalCount = 0;
    data.summary.watchCount = 0;
    data.summary.reviewCount = 0;
    data.summary.activeMarkerCount = 0;
    return data;
  }
  const predictionByMarker = new Map(response.predictions.map((item) => [item.marker, item]));
  data.substances = data.substances
    .filter((substance) => predictionByMarker.has(substance.abbr))
    .map((substance) => {
    const copy = cloneData(substance);
    const prediction = predictionByMarker.get(copy.abbr);
    copy.indicator.predicted = prediction.predicted;
    copy.indicator.nSpectra = prediction.nSpectra;
    copy.indicator.sd = prediction.sd;
    copy.indicator.status = inferStatus(copy.indicator.predicted, copy.indicator.reference);
    copy.indicator.level = { 常规范围: "normal", 建议关注: "watch", 需复核: "review" }[copy.indicator.status];
    copy.regression.r2 = prediction.r2;
    copy.classification.f1 = prediction.f1;
    copy.classification.confidence = prediction.classificationConfidence;
    return copy;
  });

  data.summary.normalCount = data.substances.filter((item) => item.indicator.level === "normal").length;
  data.summary.watchCount = data.substances.filter((item) => item.indicator.level === "watch").length;
  data.summary.reviewCount = data.substances.filter((item) => item.indicator.level === "review").length;
  data.summary.activeMarkerCount = data.substances.length;
  return data;
}

function inferStatus(value, reference) {
  const [low, high] = String(reference).split("-").map(Number);
  if (Number.isFinite(low) && Number.isFinite(high) && value >= low && value <= high) return "常规范围";
  if (Number.isFinite(low) && Number.isFinite(high) && (value < low * 0.75 || value > high * 1.25)) return "需复核";
  return "建议关注";
}

function renderSampleStrip(data) {
  const sample = data.sample;
  const items = [
    ["样本编号", sample.id],
    ["检测批次", sample.batch],
    ["样本类型", sample.type],
    ["光谱数量", `${sample.spectraCount} 条`],
    ["检测范围", sample.waveRange],
    ["报告状态", state.reportStatus],
  ];
  el("#sample-strip").innerHTML = items
    .map(([label, value]) => `<div class="sample-item"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");
  el("#top-title").textContent = `${sample.type} · ${sample.id}`;
  el("#report-state").textContent = state.reportStatus;
}

function renderPipeline() {
  el("#pipeline-steps").innerHTML = pipelineLabels
    .map(([key, label], index) => {
      const done = state.pipeline[key];
      const current = !done && Object.values(state.pipeline).slice(0, index).every(Boolean);
      return `
        <div class="pipeline-step ${done ? "done" : ""} ${current ? "current" : ""}">
          <span>${index + 1}</span>
          <strong>${label}</strong>
        </div>
      `;
    })
    .join("");
}

function renderUploadStats() {
  const spectrum = state.uploadedSpectrum;
  const qc = state.qc;
  const importResult = state.importResult;
  if (!spectrum) {
    el("#upload-stats").innerHTML = `
      <div class="upload-stat muted-box"><strong>输入状态</strong><span>尚未导入光谱</span></div>
      <div class="upload-stat muted-box"><strong>识别结果</strong><span>等待文件识别</span></div>
      <div class="upload-stat muted-box"><strong>自动质控</strong><span>等待光谱文件</span></div>
      <div class="upload-stat muted-box"><strong>分析状态</strong><span>等待分析</span></div>
    `;
    return;
  }
  el("#upload-stats").innerHTML = `
    <div class="upload-stat"><strong>${spectrum.points.length}</strong><span>有效数据点</span></div>
    <div class="upload-stat"><strong>${state.sampleInterpretation?.modeLabel || (importResult ? importResult.layoutLabel : "单条光谱")}</strong><span>${importResult ? importResult.candidates.length : 1} 条候选光谱</span></div>
    <div class="upload-stat"><strong>${Math.round(spectrum.range[0])}-${Math.round(spectrum.range[1])}</strong><span>Raman shift (cm⁻¹)</span></div>
    <div class="upload-stat ${qc && qc.overall >= 85 ? "good" : "warn"}"><strong>${qc ? qc.overall.toFixed(1) : "--"}</strong><span>质控评分</span></div>
  `;
}

function renderSpectrumSelection() {
  const target = el("#spectrum-selection");
  if (state.importError) {
    target.innerHTML = `
      <div class="import-error-card">
        <strong>光谱文件未通过导入检查</strong>
        <p>${escapeHtml(state.importError)}</p>
        <span>请确认文件包含拉曼位移和光谱强度数据，或使用 CSV、TXT、TSV 格式重新导入。</span>
      </div>
    `;
    return;
  }
  if (!state.importResult) {
    target.innerHTML = "";
    return;
  }
  const result = state.importResult;
  const interpretation = state.sampleInterpretation || setInterpretation(result);
  const prediction = state.uploadedSpectrum?.spectralPrediction;
  const notes = [
    result.hasWavenumberAxis ? "已识别拉曼位移轴" : "未识别明确拉曼位移轴，按 400-1800 cm⁻¹ 默认网格处理",
    result.labelColumns.length ? `已剥离标签列：${result.labelColumns.join("、")}` : "未检测到独立标签列",
    result.candidates.length > 1 ? "检测到多条候选光谱，请选择其中一条进入单光谱分析" : "检测到单条候选光谱，可进行定性识别与对应定量",
    interpretation.reportHint,
  ];
  const cards = result.candidates
    .map((candidate, index) => `
      <article class="spectrum-option ${index === state.selectedSpectrumIndex ? "active" : ""}">
        <button class="spectrum-pick" data-spectrum-index="${index}" type="button">
          <strong>${candidate.name}</strong>
          <span>${candidate.points.length} 点 · ${Math.round(candidate.range[0])}-${Math.round(candidate.range[1])} cm⁻¹</span>
          <em>${candidate.spectralPrediction ? `${candidate.spectralPrediction.marker} · ${candidate.spectralPrediction.name} · 置信度 ${pct(candidate.spectralPrediction.confidence)}` : "待识别"}</em>
        </button>
      </article>
    `)
    .join("");
  const mapping = result.candidates
    .filter((candidate) => candidate.spectralPrediction)
    .map((candidate) => `${candidate.name} → ${candidate.spectralPrediction.marker}`)
    .join("；");
  const ranking = prediction?.scores?.slice(0, 6)
    .map((score) => `
      <div class="rank-row">
        <span>${score.marker} · ${score.name}</span>
        <strong>${pct(score.similarity)}</strong>
        <i style="--value:${Math.max(5, Math.min(100, score.similarity * 100))}%"></i>
      </div>
    `)
    .join("") || "";
  if (result.candidates.length === 1) {
    target.innerHTML = `
      <div class="single-import-line">
        <div>
          <p class="section-kicker">Import recognition</p>
          <strong>${result.layoutLabel} · ${result.hasWavenumberAxis ? "已识别拉曼位移轴" : "按默认位移轴处理"}</strong>
          <span>${interpretation.reportHint}</span>
        </div>
        <div class="single-import-result">
          <span>定性候选</span>
          <strong>${prediction ? `${prediction.marker} · ${prediction.name}` : "等待识别"}</strong>
          <em>${prediction ? `置信度 ${pct(prediction.confidence)}` : "导入后显示"}</em>
        </div>
      </div>
    `;
    return;
  }
  target.innerHTML = `
    <div class="selection-header">
      <div>
        <p class="section-kicker">Import recognition</p>
        <h4>数据格式识别</h4>
      </div>
      <span>${result.layoutLabel}</span>
    </div>
    <div class="recognition-notes">${notes.map((note) => `<span>${note}</span>`).join("")}</div>
    <div class="sample-interpretation">
      <div><span>样本判断</span><strong>${interpretation.sampleTypeLabel}</strong></div>
      <div><span>分析模式</span><strong>${interpretation.modeLabel}</strong></div>
      <div><span>模型识别</span><strong>${mapping || "识别置信度不足"}</strong></div>
    </div>
    <div class="method-note">
      <strong>分析依据</strong>
      <span>当前网页端依据前期ASFN结果、六类糖尿病标志物平均SERS模板和输入光谱质控评分组织定性与定量输出；完整深度学习权重尚未部署到网页端。</span>
    </div>
    <div class="classification-panel">
      <div class="classification-head">
        <div>
          <p class="section-kicker">Qualitative recognition</p>
          <h4>定性识别候选排序</h4>
        </div>
        <span>${prediction ? `Top-1 ${prediction.marker} · ${pct(prediction.confidence)}` : "等待光谱"}</span>
      </div>
      <div class="rank-list">${ranking || "<span>导入光谱后显示相似度排序。</span>"}</div>
    </div>
    <div class="spectrum-options">${cards}</div>
  `;
  target.querySelectorAll(".spectrum-pick").forEach((button) => {
    button.addEventListener("click", () => {
      selectSpectrum(Number(button.dataset.spectrumIndex));
    });
  });
}

function renderAnalysisContract() {
  const target = el("#analysis-contract");
  if (!target) return;
  const request = state.analysisRequest;
  const response = state.analysisResponse;
  const interpretation = state.sampleInterpretation;
  if (!state.uploadedSpectrum || !interpretation) {
    target.innerHTML = "";
    return;
  }
  const markers = interpretation.substances.length
    ? interpretation.substances.map((abbr) => `<span>${abbr}</span>`).join("")
    : `<span>待确认</span>`;
  const requestId = request?.requestId || "待生成";
  const responseStatus = response?.status === "completed" ? "已完成" : response?.status === "channel_required" ? "通道待确认" : "等待分析";
  target.innerHTML = `
    <div class="contract-header">
      <div>
        <p class="section-kicker">ASFN task</p>
        <h4>分析任务</h4>
      </div>
      <span>${responseStatus}</span>
    </div>
    <div class="contract-grid">
      <div><span>任务编号</span><strong>${requestId}</strong></div>
      <div><span>分析模式</span><strong>${interpretation.modeLabel}</strong></div>
      <div><span>分析模块</span><strong>${state.analysisBackend}</strong></div>
      <div><span>预测对象</span><strong class="marker-list">${markers}</strong></div>
      <div><span>识别置信度</span><strong>${interpretation.confidence ? pct(interpretation.confidence) : "待确认"}</strong></div>
      <div><span>候选间隔</span><strong>${interpretation.margin ? pct(interpretation.margin) : "待确认"}</strong></div>
    </div>
    <div class="method-note compact-note">
      <strong>模型接入状态</strong>
      <span>网页端展示为ASFN结果适配层，未加载.pth权重；定量结果来自前期ASFN平均浓度预测结果并按当前光谱质控状态修正。</span>
    </div>
  `;
}

function addAnalysisHistory() {
  const sample = state.data?.sample;
  const interpretation = state.sampleInterpretation;
  const response = state.analysisResponse;
  if (!sample || !interpretation || !response) return;
  const item = {
    id: response.requestId || createRequestId(),
    sampleId: sample.id,
    mode: interpretation.modeLabel || "等待光谱",
    status: response.status === "completed" ? "分析完成" : "通道待确认",
    time: sample.analyzedAt || new Date().toLocaleString("zh-CN", { hour12: false }),
    markers: interpretation.substances?.length ? interpretation.substances.join("、") : "待确认",
  };
  state.analysisHistory = [
    item,
    ...state.analysisHistory.filter((row) => row.id !== item.id),
  ].slice(0, 6);
}

function renderHistory() {
  const list = el("#history-list");
  const count = el("#history-count");
  if (!list || !count) return;
  count.textContent = state.analysisHistory.length;
  if (!state.analysisHistory.length) {
    list.innerHTML = `<div class="history-empty">暂无分析记录</div>`;
    return;
  }
  list.innerHTML = state.analysisHistory
    .map((item) => `
      <article class="history-item">
        <div>
          <strong>${item.sampleId}</strong>
          <span>${item.mode} · ${item.markers}</span>
        </div>
        <em class="${item.status === "分析完成" ? "ok" : "warn"}">${item.status}</em>
        <small>${item.time}</small>
      </article>
    `)
    .join("");
}

function selectSpectrum(index) {
  if (!state.importResult?.candidates[index]) return;
  state.selectedSpectrumIndex = index;
  state.uploadedSpectrum = state.importResult.candidates[index];
  setInterpretation(state.importResult, index);
  state.qc = computeQc(state.uploadedSpectrum);
  resetAnalysisState();
  setUploadMessage(`已选择 ${state.uploadedSpectrum.name}，${state.sampleInterpretation.reportHint}`);
  renderAll();
}

function renderSummary(data) {
  const summary = data.summary;
  const active = data.substances || [];
  const meanR2 = active.length
    ? active.reduce((acc, item) => acc + Number(item.regression.r2 || 0), 0) / active.length
    : null;
  const meanF1 = active.length
    ? active.reduce((acc, item) => acc + Number(item.classification.f1 || 0), 0) / active.length
    : null;
  const confidence = state.sampleInterpretation?.confidence || null;
  const cards = [
    [active.length ? "识别置信度" : "识别状态", active.length && confidence ? pct(confidence) : "待确认"],
    ["当前R²", meanR2 === null ? "待确认" : fmt(meanR2, 4)],
    ["当前F1", meanF1 === null ? "待确认" : pct(meanF1)],
    ["输出对象", active.length ? `${active[0].abbr}` : "待确认"],
  ];
  el("#summary-cards").innerHTML = cards
    .map(([label, value]) => `<div class="summary-card"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");
  el("#overview-meta").textContent = state.pipeline.analyzed ? `分析完成 · ${data.sample.analyzedAt}` : "等待单光谱分析";
}

function renderIndicators(data) {
  if (!data.substances.length) {
    el("#indicator-grid").innerHTML = `
      <article class="empty-result-card">
        <strong>未生成标志物结果</strong>
        <p>${state.sampleInterpretation?.reportHint || "请先完成光谱导入、通道确认和自动质控。"}</p>
      </article>
    `;
    return;
  }
  el("#indicator-grid").innerHTML = data.substances
    .map((substance) => {
      const indicator = substance.indicator;
      return `
        <article class="indicator-card ${levelClass[indicator.level] || ""}" data-substance="${substance.abbr}">
          <div class="indicator-title">
            <div>
              <h4>${substance.name}</h4>
              <p>${substance.abbr}</p>
            </div>
            ${createStatusPill(indicator.status)}
          </div>
          <div class="indicator-value">
            <strong>${fmt(indicator.predicted, 3)}</strong>
            <span>${indicator.unit}</span>
          </div>
          <div class="indicator-foot">
            <span>辅助区间 ${indicator.reference}</span>
            <span>n=${indicator.nSpectra}</span>
          </div>
          <div class="indicator-foot">
            <span>识别置信度 ${substance.classification.confidence ? pct(substance.classification.confidence) : "--"}</span>
            <span>R² ${fmt(substance.regression.r2, 4)}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderQc(data) {
  const qcs = state.qc
    ? [
        ["光谱有效性", state.qc.validRange ? "通过" : "需复核", state.qc.validRange ? 96 : 68],
        ["信号动态范围", state.qc.signalSpan > 0.8 ? "良好" : "偏低", state.qc.dynamicScore],
        ["基线稳定性", state.qc.baselineScore >= 80 ? "良好" : "需复核", state.qc.baselineScore],
        ["模型输入完整性", state.qc.complete ? "通过" : "需复核", state.qc.complete ? 100 : 60],
      ]
    : [
        ["光谱有效性", "通过", 96],
        ["重复采样一致性", "良好", 91],
        ["基线稳定性", "良好", 89],
        ["模型输入完整性", "通过", 100],
      ];
  el("#qc-list").innerHTML = qcs
    .map(([name, stateText, value]) => `
      <div class="qc-item">
        <div class="qc-top"><strong>${name}</strong><span>${stateText}</span></div>
        <div class="progress"><i style="--value:${value}%"></i></div>
      </div>
    `)
    .join("");

  const review = data.substances
    .filter((item) => item.indicator.level === "review")
    .map((item) => item.name)
    .join("、");
  const normal = data.substances
    .filter((item) => item.indicator.level === "normal")
    .map((item) => item.name)
    .join("、");

  const prefix = state.sampleInterpretation ? `${state.sampleInterpretation.reportHint}` : "";
  el("#decision-box").innerHTML = `
    <strong>综合提示</strong>
    <p>${prefix ? `${prefix} ` : ""}${data.substances.length ? (review ? `${review} 当前结果提示需要复核。` : "当前检测指标未触发复核提示。") : "当前未生成标志物浓度结果。"}${
      normal ? `${normal} 处于平台辅助区间内。` : ""
    }建议结合光谱质量检查和重复检测结果进行综合判断。</p>
  `;
}

function renderWorkflowList() {
  const steps = [
    ["imported", "光谱导入完成"],
    ["qc", "质量检查通过"],
    ["analyzed", "智能分析完成"],
    ["reported", "人工复核"],
    ["reported", "报告归档"],
  ];
  const firstOpen = steps.findIndex(([key]) => !state.pipeline[key]);
  const activeIndex = state.pipeline.analyzed ? 3 : (firstOpen === -1 ? 3 : firstOpen);
  el("#workflow-list").innerHTML = steps
    .map(([key, label], index) => {
      const done = state.pipeline[key] && index < 3;
      const active = index === activeIndex;
      return `<li class="${done ? "done" : ""} ${active ? "active" : ""}"><span>${index + 1}</span>${label}</li>`;
    })
    .join("");
}

function renderShiftTags(selector, shifts) {
  const target = el(selector);
  if (!target) return;
  target.innerHTML = shifts
    .map((shift) => `<span class="shift-tag">${shift} cm⁻¹</span>`)
    .join("");
}

function renderBands(data) {
  const interpretation = state.sampleInterpretation;
  if (state.uploadedSpectrum && !data.substances.length) {
    el("#band-list").innerHTML = `
      <div class="band-item spectrum-state-card">
        <strong><span>当前输入光谱</span><span>${interpretation?.modeLabel || "待确认"}</span></strong>
        <span>${interpretation?.reportHint || "请先导入光谱并完成通道确认。"}</span>
      </div>
    `;
    return;
  }
  const activeMarkers = data.substances.map((item) => item.abbr);
  const sourceBands = activeMarkers.length
    ? data.keyBands.filter((band) => activeMarkers.includes(band.substance))
    : data.keyBands;
  el("#band-list").innerHTML = sourceBands
    .slice(0, 10)
    .map((band) => `
      <div class="band-item">
        <strong><span>${band.name}</span><span>${band.shift} cm⁻¹</span></strong>
        <span>${band.assignment} · SNR ${band.snr} · 检出率 ${band.rate}%</span>
      </div>
    `)
    .join("");
}

function normalize(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values.map((value) => (value - min) / span);
}

function renderUploadSpectrumPreview() {
  const svg = el("#upload-spectrum-preview");
  const meta = el("#preview-meta");
  if (!svg) return;
  const spectrum = state.uploadedSpectrum;
  const viewBox = { w: 620, h: 220, left: 48, right: 22, top: 18, bottom: 42 };
  if (!spectrum?.points?.length) {
    if (meta) meta.textContent = "等待导入";
    svg.outerHTML = `
      <svg id="upload-spectrum-preview" role="img" aria-label="导入光谱预览" viewBox="0 0 ${viewBox.w} ${viewBox.h}" xmlns="http://www.w3.org/2000/svg">
        <rect x="1.5" y="1.5" width="${viewBox.w - 3}" height="${viewBox.h - 3}" rx="14" fill="#ffffff" stroke="#17222d" stroke-width="3"/>
        <path d="M68,143 C122,108 176,134 230,95 S338,118 392,78 500,120 552,82" fill="none" stroke="#b9c8d1" stroke-width="3" stroke-linecap="round"/>
        <text class="chart-label" x="${viewBox.w / 2}" y="112" text-anchor="middle" fill="#6d7a86">导入后显示当前光谱曲线</text>
      </svg>
    `;
    return;
  }
  const points = spectrum.points.filter((item) => item.wavenumber >= 400 && item.wavenumber <= 1800);
  if (meta) meta.textContent = `${points.length} 点 · ${Math.round(spectrum.range[0])}-${Math.round(spectrum.range[1])} cm⁻¹`;
  if (!points.length) return;
  const values = normalize(points.map((item) => item.intensity));
  const plotW = viewBox.w - viewBox.left - viewBox.right;
  const plotH = viewBox.h - viewBox.top - viewBox.bottom;
  const x = (wn) => viewBox.left + ((wn - 400) / 1400) * plotW;
  const y = (value) => viewBox.top + (1 - value) * plotH;
  const d = values
    .map((value, index) => `${index === 0 ? "M" : "L"}${x(points[index].wavenumber).toFixed(2)},${y(value).toFixed(2)}`)
    .join(" ");
  const ticks = [400, 700, 1000, 1300, 1600, 1800];
  svg.outerHTML = `
    <svg id="upload-spectrum-preview" role="img" aria-label="导入光谱预览" viewBox="0 0 ${viewBox.w} ${viewBox.h}" xmlns="http://www.w3.org/2000/svg">
      <rect x="1.5" y="1.5" width="${viewBox.w - 3}" height="${viewBox.h - 3}" rx="14" fill="#ffffff" stroke="#17222d" stroke-width="3"/>
      <g stroke="#e0e9ee" stroke-width="1">
        ${ticks.map((t) => `<line x1="${x(t)}" x2="${x(t)}" y1="${viewBox.top}" y2="${viewBox.h - viewBox.bottom}"/>`).join("")}
      </g>
      <line x1="${viewBox.left}" y1="${viewBox.h - viewBox.bottom}" x2="${viewBox.w - viewBox.right}" y2="${viewBox.h - viewBox.bottom}" stroke="#17222d" stroke-width="3"/>
      <line x1="${viewBox.left}" y1="${viewBox.top}" x2="${viewBox.left}" y2="${viewBox.h - viewBox.bottom}" stroke="#17222d" stroke-width="3"/>
      ${ticks.map((t) => `<text class="chart-tick" x="${x(t)}" y="${viewBox.h - 16}" text-anchor="middle">${t}</text>`).join("")}
      <path d="${d}" fill="none" stroke="#168b82" stroke-width="3.4" stroke-linejoin="round" stroke-linecap="round"/>
      <text class="chart-label" x="${viewBox.left + 6}" y="${viewBox.top + 16}" fill="#193247">${escapeHtml(spectrum.name || "Input spectrum")}</text>
      <text class="axis-label" x="${viewBox.left + plotW / 2}" y="${viewBox.h - 3}" text-anchor="middle">Raman shift (cm⁻¹)</text>
    </svg>
  `;
}

function renderSpectrumChart(data) {
  const svg = el("#spectrum-chart");
  const interpretation = state.sampleInterpretation;
  const viewBox = { w: 860, h: 430, left: 58, right: 108, top: 30, bottom: 55 };
  const xMin = state.spectrumMode === "focus" ? 620 : 400;
  const xMax = state.spectrumMode === "focus" ? 1650 : 1800;
  const referencePoints = data.spectra.filter((item) => item.wavenumber >= xMin && item.wavenumber <= xMax);
  const uploadedPoints = state.uploadedSpectrum?.points?.filter((item) => item.wavenumber >= xMin && item.wavenumber <= xMax) || [];
  const showUploaded = Boolean(state.uploadedSpectrum && (!interpretation?.completePanel || !data.substances.length));
  const substances = showUploaded ? ["Input"] : data.substances.map((item) => item.abbr);
  const points = showUploaded ? uploadedPoints : referencePoints;
  const plotW = viewBox.w - viewBox.left - viewBox.right;
  const plotH = viewBox.h - viewBox.top - viewBox.bottom;
  if (!points.length || !substances.length) {
    svg.outerHTML = `
      <svg id="spectrum-chart" role="img" aria-label="当前光谱状态" viewBox="0 0 ${viewBox.w} ${viewBox.h}" xmlns="http://www.w3.org/2000/svg">
        <rect x="1.5" y="1.5" width="${viewBox.w - 3}" height="${viewBox.h - 3}" rx="14" fill="#ffffff" stroke="#17222d" stroke-width="3"/>
        <text class="chart-label" x="${viewBox.w / 2}" y="${viewBox.h / 2 - 8}" text-anchor="middle" fill="#193247">等待光谱输入</text>
        <text class="chart-tick" x="${viewBox.w / 2}" y="${viewBox.h / 2 + 26}" text-anchor="middle" fill="#6d7a86">导入光谱后显示当前检测曲线</text>
      </svg>
    `;
    return;
  }

  const x = (wn) => viewBox.left + ((wn - xMin) / (xMax - xMin)) * plotW;
  const yFor = (norm, index) => {
    const rowH = plotH / substances.length;
    return viewBox.top + index * rowH + rowH * 0.82 - norm * rowH * 0.62;
  };

  const ticks = state.spectrumMode === "focus" ? [700, 900, 1100, 1300, 1500] : [400, 700, 1000, 1300, 1600, 1800];
  let markup = `
    <svg viewBox="0 0 ${viewBox.w} ${viewBox.h}" xmlns="http://www.w3.org/2000/svg">
      <rect x="1.5" y="1.5" width="${viewBox.w - 3}" height="${viewBox.h - 3}" rx="14" fill="#ffffff" stroke="#17222d" stroke-width="3"/>
      <g stroke="#d9e4ea" stroke-width="1">
        ${ticks.map((t) => `<line x1="${x(t)}" x2="${x(t)}" y1="${viewBox.top}" y2="${viewBox.h - viewBox.bottom}"/>`).join("")}
      </g>
      <line x1="${viewBox.left}" y1="${viewBox.h - viewBox.bottom}" x2="${viewBox.w - viewBox.right}" y2="${viewBox.h - viewBox.bottom}" stroke="#17222d" stroke-width="3"/>
      <line x1="${viewBox.left}" y1="${viewBox.top}" x2="${viewBox.left}" y2="${viewBox.h - viewBox.bottom}" stroke="#17222d" stroke-width="3"/>
      ${ticks.map((t) => `<line x1="${x(t)}" x2="${x(t)}" y1="${viewBox.h - viewBox.bottom}" y2="${viewBox.h - viewBox.bottom + 7}" stroke="#17222d" stroke-width="2"/><text class="chart-tick" x="${x(t)}" y="${viewBox.h - 22}" text-anchor="middle">${t}</text>`).join("")}
      <text class="axis-label" x="${viewBox.left + plotW / 2}" y="${viewBox.h - 6}" text-anchor="middle">Raman shift (cm⁻¹)</text>
  `;

  substances.forEach((sub, index) => {
    const rawValues = showUploaded ? points.map((item) => item.intensity) : points.map((item) => item[sub]);
    const series = normalize(rawValues);
    const d = series
      .map((value, i) => `${i === 0 ? "M" : "L"}${x(points[i].wavenumber).toFixed(2)},${yFor(value, index).toFixed(2)}`)
      .join(" ");
    const labelY = showUploaded ? yFor(0.82, index) : yFor(0.76, index);
    const label = showUploaded
      ? (state.uploadedSpectrum.name || "Input")
      : sub;
    const stroke = showUploaded ? "#1f9b90" : colors[sub];
    markup += `
      <path d="${d}" fill="none" stroke="${stroke}" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"/>
      <text class="chart-label" x="${viewBox.w - viewBox.right + 20}" y="${labelY}" fill="${stroke}">${label}</text>
    `;
  });

  const important = showUploaded ? [] : [
    ...data.importantShifts.classification.slice(0, 3),
    ...data.importantShifts.quantification.slice(0, 3),
  ].filter((shift) => shift >= xMin && shift <= xMax);
  if (showUploaded) {
    markup += `
      <text class="chart-label" x="${viewBox.left + 12}" y="${viewBox.top + 24}" fill="#193247">${interpretation?.sampleTypeLabel || "上传光谱"}</text>
      <text class="chart-tick" x="${viewBox.left + 12}" y="${viewBox.top + 48}" fill="#6d7a86">${interpretation?.reportHint || ""}</text>
    `;
  }
  markup += important
    .map((shift) => `
      <line x1="${x(shift)}" x2="${x(shift)}" y1="${viewBox.top + 5}" y2="${viewBox.h - viewBox.bottom - 5}" stroke="#7d8d98" stroke-width="1.6" stroke-dasharray="6 7" opacity="0.55"/>
    `)
    .join("");
  markup += "</svg>";
  svg.outerHTML = markup.replace("<svg", '<svg id="spectrum-chart" role="img" aria-label="平均SERS光谱"');
}

function renderResultTable(data) {
  if (!data.substances.length) {
    el("#result-table-body").innerHTML = `
      <tr>
        <td colspan="7">未达到可靠识别阈值，暂不生成标志物浓度结果。</td>
      </tr>
    `;
    return;
  }
  el("#result-table-body").innerHTML = data.substances
    .map((substance) => {
      const indicator = substance.indicator;
      return `
        <tr>
          <td><div class="substance-cell"><strong>${substance.name}</strong><span>${substance.abbr}</span></div></td>
          <td><strong>${fmt(indicator.predicted, 3)}</strong> ${indicator.unit}</td>
          <td>${indicator.reference} ${indicator.unit}</td>
          <td>${createStatusPill(indicator.status)}</td>
          <td>${fmt(substance.regression.r2, 4)}</td>
          <td>${fmt(substance.classification.f1, 3)}</td>
          <td>${indicator.nSpectra}</td>
        </tr>
      `;
    })
    .join("");
}

function renderMetricBars(data) {
  const rows = data.substances.flatMap((substance) => [
    [`${substance.abbr} 置信度`, substance.classification.confidence || 0],
    [`${substance.abbr} R²`, substance.regression.r2],
    [`${substance.abbr} F1`, substance.classification.f1],
  ]);
  if (!rows.length) {
    el("#metric-bars").innerHTML = `<div class="empty-inline">完成单光谱识别后显示模型指标。</div>`;
    return;
  }
  el("#metric-bars").innerHTML = rows
    .map(([label, value]) => `
      <div class="metric-row">
        <div class="metric-row-top"><span>${label}</span><span>${fmt(value, 3)}</span></div>
        <div class="bar-track"><i style="--value:${Math.max(5, Math.min(100, value * 100))}%"></i></div>
      </div>
    `)
    .join("");
}

function renderReport(data) {
  const sample = data.sample;
  const interpretation = state.sampleInterpretation || { type: "empty", completePanel: false, reportHint: "请先导入待分析光谱文件。" };
  const response = state.analysisResponse;
  const reviewItems = data.substances
    .filter((item) => item.indicator.level === "review")
    .map((item) => item.name);
  const normalItems = data.substances
    .filter((item) => item.indicator.level === "normal")
    .map((item) => item.name);
  const resultCards = data.substances
    .map((substance) => `
      <div class="report-result">
        <span>${substance.name}</span>
        <strong>${fmt(substance.indicator.predicted, 3)} ${substance.indicator.unit}</strong>
      </div>
    `)
    .join("") || `<div class="report-result"><span>检测通道</span><strong>待确认</strong></div>`;
  const reportTitle = interpretation.type === "single_asfn"
      ? `${substanceMeta[interpretation.substances[0]]?.name || "单项标志物"} SERS 辅助分析报告`
      : "SERS 光谱通道确认报告";
  const reportScope = interpretation.type === "single_asfn"
      ? `本报告基于单条输入光谱完成定性识别，并仅输出 ${substanceMeta[interpretation.substances[0]]?.name || "当前标志物"} 的对应浓度预测结果。`
      : "当前光谱尚未确认检测通道，报告仅记录导入识别和质量检查结果。";
  const statusText = response?.status === "completed"
    ? "分析完成"
    : response?.status === "channel_required"
      ? "通道待确认"
      : "等待分析";
  const summaryText = data.substances.length
    ? `${reviewItems.length ? `${reviewItems.join("、")}的检测结果提示需复核。` : "当前检测指标未触发复核提示。"}${normalItems.length ? `${normalItems.join("、")}处于平台辅助区间内。` : ""}`
    : `${interpretation.reportHint} 暂不生成标志物定量结果。`;
  const noteMarkup = sample.note
    ? `<div class="report-section report-note"><strong>复核备注</strong><p>${escapeHtml(sample.note)}</p></div>`
    : "";

  el("#report-preview").innerHTML = `
    <article class="report-paper">
      <h4>${reportTitle}</h4>
      <div class="report-meta">
        <div><span>报告编号</span><strong>${sample.reportId || "待生成"}</strong></div>
        <div><span>样本编号</span><strong>${sample.id}</strong></div>
        <div><span>检测批次</span><strong>${sample.batch}</strong></div>
        <div><span>检测时间</span><strong>${sample.analyzedAt}</strong></div>
        <div><span>样本类型</span><strong>${sample.type}</strong></div>
        <div><span>检测人员</span><strong>${sample.operator || "未填写"}</strong></div>
        <div><span>复核人员</span><strong>${sample.reviewer || "未填写"}</strong></div>
        <div><span>光谱数量</span><strong>${sample.spectraCount} 条</strong></div>
        <div><span>当前状态</span><strong>${state.reportStatus}</strong></div>
      </div>
      <div class="report-section">
        <strong>报告范围</strong>
        <p>${reportScope}</p>
      </div>
      <div class="report-status-grid">
        <div><span>分析状态</span><strong>${statusText}</strong></div>
        <div><span>分析模式</span><strong>${interpretation.modeLabel || "等待光谱"}</strong></div>
        <div><span>预测对象</span><strong>${interpretation.substances?.length ? interpretation.substances.join("、") : "待确认"}</strong></div>
        <div><span>识别置信度</span><strong>${interpretation.confidence ? pct(interpretation.confidence) : "待确认"}</strong></div>
      </div>
      ${noteMarkup}
      <div class="report-grid-list">${resultCards}</div>
      <div class="report-section">
        <strong>分析依据</strong>
        <p>当前报告依据前期ASFN模型结果、糖尿病标志物平均SERS模板、输入光谱相似性排序和自动质控评分生成。网页端用于科研辅助展示和复核提示，尚未部署完整深度学习权重文件。</p>
      </div>
      <div class="report-summary">
        <strong>综合提示：</strong>
        <span>${summaryText}本报告用于科研辅助分析，结果解释应结合样本背景和实验条件。</span>
      </div>
    </article>
  `;
}

function renderSampleEditor(data) {
  const sample = data.sample;
  const fields = [
    ["#sample-id-input", sample.id || ""],
    ["#sample-batch-input", sample.batch || ""],
    ["#sample-type-input", sample.type || ""],
    ["#report-id-input", sample.reportId || state.sampleEdits.reportId || ""],
    ["#operator-input", sample.operator || state.sampleEdits.operator || ""],
    ["#reviewer-input", sample.reviewer || state.sampleEdits.reviewer || ""],
    ["#sample-note-input", sample.note || state.sampleEdits.note || ""],
  ];
  fields.forEach(([selector, value]) => {
    const node = el(selector);
    if (node && document.activeElement !== node) node.value = value;
  });
}

function renderAll() {
  const data = state.data;
  renderPipeline();
  renderUploadStats();
  renderSpectrumSelection();
  renderAnalysisContract();
  renderUploadSpectrumPreview();
  renderSampleStrip(data);
  renderSummary(data);
  renderIndicators(data);
  renderQc(data);
  renderShiftTags("#class-shifts", data.importantShifts.classification);
  renderShiftTags("#reg-shifts", data.importantShifts.quantification);
  renderBands(data);
  renderSpectrumChart(data);
  renderResultTable(data);
  renderMetricBars(data);
  renderReport(data);
  renderSampleEditor(data);
  renderWorkflowList();
  renderHistory();
}

function downloadTextFile(fileName, content, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function collectAnalysisRecord() {
  return {
    exportedAt: new Date().toISOString(),
    sample: state.data?.sample || null,
    report: {
      reportId: state.data?.sample?.reportId || state.sampleEdits.reportId || null,
      operator: state.data?.sample?.operator || state.sampleEdits.operator || null,
      reviewer: state.data?.sample?.reviewer || state.sampleEdits.reviewer || null,
      reportStatus: state.reportStatus,
    },
    interpretation: state.sampleInterpretation,
    qc: state.qc,
    analysisRequest: state.analysisRequest,
    analysisResponse: state.analysisResponse,
    results: state.data?.substances?.map((substance) => ({
      marker: substance.abbr,
      name: substance.name,
      predicted: substance.indicator.predicted,
      unit: substance.indicator.unit,
      reference: substance.indicator.reference,
      status: substance.indicator.status,
      r2: substance.regression.r2,
      f1: substance.classification.f1,
      nSpectra: substance.indicator.nSpectra,
    })) || [],
    note: state.sampleEdits.note || "",
    boundary: "平台结果用于科研场景下的辅助分析和复核提示，不替代临床诊断结论。",
  };
}

function exportAnalysisJson() {
  const record = collectAnalysisRecord();
  const sampleId = record.sample?.id || "SERS-report";
  downloadTextFile(`${sampleId}_analysis_record.json`, JSON.stringify(record, null, 2), "application/json;charset=utf-8");
}

function exportReportHtml() {
  const sampleId = state.data?.sample?.id || "SERS-report";
  const report = el("#report-preview")?.innerHTML || "";
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(sampleId)} SERS report</title>
  <style>
    body { margin: 0; padding: 32px; background: #eef3f6; color: #17222d; font-family: SimSun, "Times New Roman", serif; }
    .report-paper { max-width: 920px; margin: 0 auto; border: 1px solid #dbe4ea; border-radius: 18px; background: #fff; padding: 28px; }
    h4 { text-align: center; margin: 0 0 20px; font-size: 23px; }
    .report-meta, .report-status-grid, .report-grid-list { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 18px; }
    .report-grid-list { grid-template-columns: repeat(2, 1fr); }
    .report-meta div, .report-status-grid div, .report-result, .report-section { padding: 11px 12px; border-radius: 12px; background: #f7fafb; border: 1px solid #dbe4ea; }
    span { color: #6d7a86; }
    .report-result { display: flex; justify-content: space-between; gap: 14px; }
    .report-summary { border-top: 1px solid #dbe4ea; padding-top: 18px; line-height: 1.85; }
  </style>
</head>
<body>${report}</body>
</html>`;
  downloadTextFile(`${sampleId}_report_snapshot.html`, html, "text/html;charset=utf-8");
}

function switchView(viewName) {
  state.activeView = viewName;
  els(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === viewName));
  els(".stage-tab").forEach((item) => item.classList.toggle("active", item.dataset.view === viewName));
  els(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${viewName}`));
  if (viewName === "spectrum") {
    renderSpectrumChart(state.data);
    renderUploadSpectrumPreview();
  }
}

function saveSampleInfo() {
  state.sampleEdits.id = el("#sample-id-input")?.value.trim() || "";
  state.sampleEdits.batch = el("#sample-batch-input")?.value.trim() || "";
  state.sampleEdits.type = el("#sample-type-input")?.value.trim() || "";
  state.sampleEdits.reportId = el("#report-id-input")?.value.trim() || state.sampleEdits.reportId || createReportId();
  state.sampleEdits.operator = el("#operator-input")?.value.trim() || "未填写";
  state.sampleEdits.reviewer = el("#reviewer-input")?.value.trim() || "未填写";
  state.sampleEdits.note = el("#sample-note-input")?.value.trim() || "";
  if (state.uploadedSpectrum) updateSampleFromSpectrum(state.data, state.uploadedSpectrum);
  setUploadMessage("样本信息已保存，报告预览已更新。");
  renderAll();
}

function splitTableRows(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/[\t,;，]+|\s{2,}/).map((cell) => cell.trim()).filter(Boolean));
}

function toNumber(value) {
  if (value === null || value === undefined) return NaN;
  const normalized = String(value).replace(/，/g, "").replace(/cm-?1|cm⁻¹|a\.u\.|au/gi, "");
  return Number(normalized);
}

function numericRatio(cells) {
  if (!cells.length) return 0;
  return cells.filter((cell) => Number.isFinite(toNumber(cell))).length / cells.length;
}

function looksLikeWavenumber(values) {
  const nums = values.map(toNumber).filter(Number.isFinite);
  if (nums.length < 20) return false;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const increasing = nums.slice(1).filter((value, index) => value >= nums[index]).length / (nums.length - 1);
  return min >= 250 && min <= 600 && max >= 1500 && max <= 2200 && increasing > 0.88;
}

function defaultAxis(length) {
  if (length <= 1) return [400];
  return Array.from({ length }, (_, index) => 400 + (1400 * index) / (length - 1));
}

function makeCandidate(name, axis, intensities, sourceMeta = {}) {
  const points = axis
    .map((wn, index) => ({ wavenumber: Number(wn), intensity: Number(intensities[index]) }))
    .filter((point) => Number.isFinite(point.wavenumber) && Number.isFinite(point.intensity))
    .sort((a, b) => a.wavenumber - b.wavenumber);
  if (points.length < 20) return null;
  return {
    name,
    sampleId: `SERS-UP-${Date.now().toString().slice(-8)}-${Math.floor(Math.random() * 90 + 10)}`,
    points,
    range: [points[0].wavenumber, points[points.length - 1].wavenumber],
    sourceMeta,
  };
}

function resetAnalysisState() {
  state.pipeline.imported = true;
  state.pipeline.qc = false;
  state.pipeline.analyzed = false;
  state.pipeline.reported = false;
  state.reportStatus = "待复核";
  state.analysisRequest = null;
  state.analysisResponse = null;
  state.data = cloneData(state.rawData);
  state.data.substances = [];
  state.data.summary.normalCount = 0;
  state.data.summary.watchCount = 0;
  state.data.summary.reviewCount = 0;
  if (state.uploadedSpectrum) updateSampleFromSpectrum(state.data, state.uploadedSpectrum);
  state.data.sample.reportStatus = state.reportStatus;
}

function parseSpectrumText(text, fileName = "uploaded-spectrum") {
  const rowsRaw = splitTableRows(text);
  if (!rowsRaw.length) throw new Error("未读取到有效文本行。");

  const hasHeader = numericRatio(rowsRaw[0]) < 0.55;
  const headers = hasHeader ? rowsRaw[0] : rowsRaw[0].map((_, index) => `列${index + 1}`);
  const rows = hasHeader ? rowsRaw.slice(1) : rowsRaw;
  const maxCols = Math.max(...rows.map((row) => row.length), headers.length);
  const normalizedRows = rows.map((row) => Array.from({ length: maxCols }, (_, index) => row[index] ?? ""));
  const normalizedHeaders = Array.from({ length: maxCols }, (_, index) => headers[index] ?? `列${index + 1}`);
  const columns = normalizedHeaders.map((header, colIndex) => ({
    header,
    values: normalizedRows.map((row) => row[colIndex] ?? ""),
    ratio: numericRatio(normalizedRows.map((row) => row[colIndex] ?? "")),
  }));

  const candidates = [];
  const labelColumns = columns.filter((column) => column.ratio < 0.35).map((column) => column.header);
  const numericColumns = columns.filter((column) => column.ratio >= 0.75);
  const firstCol = columns[0];
  const firstColIsAxis = firstCol && looksLikeWavenumber(firstCol.values);
  const firstRowIsAxis = rows.length > 1 && looksLikeWavenumber(rowsRaw[hasHeader ? 1 : 0].slice(hasHeader ? 0 : 0));

  if (firstColIsAxis && numericColumns.length >= 2) {
    const axis = firstCol.values.map(toNumber);
    numericColumns
      .filter((column) => column !== firstCol)
      .forEach((column) => {
        const candidate = makeCandidate(column.header, axis, column.values.map(toNumber), {
          layout: "column-vector",
          fileName,
        });
        if (candidate) candidates.push(candidate);
      });
    return {
      fileName,
      layout: candidates.length > 1 ? "multi-column" : "single-column",
      layoutLabel: candidates.length > 1 ? "列向量多光谱" : "列向量单光谱",
      hasWavenumberAxis: true,
      labelColumns,
      candidates,
    };
  }

  const firstNumericRowIndex = rows.findIndex((row) => numericRatio(row) >= 0.75);
  if (firstNumericRowIndex >= 0 && looksLikeWavenumber(rows[firstNumericRowIndex])) {
    const axis = rows[firstNumericRowIndex].map(toNumber).filter(Number.isFinite);
    rows.slice(firstNumericRowIndex + 1).forEach((row, offset) => {
      const values = row.map(toNumber).filter(Number.isFinite);
      if (values.length >= axis.length * 0.75) {
        const label = hasHeader && normalizedHeaders[offset] ? normalizedHeaders[offset] : `光谱${offset + 1}`;
        const candidate = makeCandidate(label, axis, values.slice(0, axis.length), {
          layout: "row-vector",
          fileName,
        });
        if (candidate) candidates.push(candidate);
      }
    });
    return {
      fileName,
      layout: candidates.length > 1 ? "multi-row" : "single-row",
      layoutLabel: candidates.length > 1 ? "行向量多光谱" : "行向量单光谱",
      hasWavenumberAxis: true,
      labelColumns,
      candidates,
    };
  }

  if (numericColumns.length === 1 && numericColumns[0].values.length >= 80) {
    const values = numericColumns[0].values.map(toNumber).filter(Number.isFinite);
    const axis = defaultAxis(values.length);
    const candidate = makeCandidate(numericColumns[0].header || fileName, axis, values, {
      layout: "single-intensity-vector",
      fileName,
    });
    if (candidate) candidates.push(candidate);
  } else if (numericColumns.length > 1) {
    const axis = defaultAxis(numericColumns[0].values.length);
    numericColumns.forEach((column) => {
      const candidate = makeCandidate(column.header, axis, column.values.map(toNumber), {
        layout: "matrix-without-axis",
        fileName,
      });
      if (candidate) candidates.push(candidate);
    });
  } else {
    normalizedRows.forEach((row, index) => {
      const nums = row.map(toNumber).filter(Number.isFinite);
      if (nums.length >= 80) {
        const candidate = makeCandidate(`光谱${index + 1}`, defaultAxis(nums.length), nums, {
          layout: "row-vector-without-axis",
          fileName,
        });
        if (candidate) candidates.push(candidate);
      }
    });
  }

  if (!candidates.length) {
    throw new Error("未识别到可分析光谱。请确认文件包含 400-1800 cm⁻¹ 范围的光谱强度数据。");
  }

  return {
    fileName,
    layout: candidates.length > 1 ? "multi-spectrum-without-axis" : "single-spectrum-without-axis",
    layoutLabel: candidates.length > 1 ? "多光谱矩阵" : "单条光谱",
    hasWavenumberAxis: false,
    labelColumns,
    candidates,
  };
}

function importSingleSpectrum(importResult) {
  state.importError = null;
  state.importResult = decorateImportResult(importResult);
  state.selectedSpectrumIndex = 0;
  state.uploadedSpectrum = state.importResult.candidates[0];
  setInterpretation(state.importResult, 0);
  state.qc = computeQc(state.uploadedSpectrum);
  resetAnalysisState();
  const multiNote = state.importResult.candidates.length > 1 ? "请在下方选择具体光谱后再开始分析。" : "可直接执行自动质控与分析。";
  setUploadMessage(`已识别 ${state.importResult.candidates.length} 条候选光谱，格式为${state.importResult.layoutLabel}，${multiNote}${state.sampleInterpretation.reportHint}`);
  renderAll();
  switchView("spectrum");
}

function parseLegacySingleSpectrum(text, fileName = "uploaded-spectrum") {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const points = [];
  for (const line of rows) {
    const cells = line.split(/[\t,; ]+/).filter(Boolean);
    if (cells.length < 2) continue;
    const x = Number(cells[0]);
    const y = Number(cells[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      points.push({ wavenumber: x, intensity: y });
    }
  }
  if (points.length < 20) {
    throw new Error("可解析光谱点少于20个，请检查文件是否包含拉曼位移和强度两列。");
  }
  points.sort((a, b) => a.wavenumber - b.wavenumber);
  return {
    name: fileName,
    sampleId: `SERS-UP-${Date.now().toString().slice(-8)}`,
    points,
    range: [points[0].wavenumber, points[points.length - 1].wavenumber],
  };
}

function createDemoSpectrum(data) {
  const demoMarker = "Trp";
  const points = data.spectra.map((row) => {
    const localRipple = 0.012 * Math.sin(row.wavenumber / 47) + 0.006 * Math.cos(row.wavenumber / 89);
    const intensity = row[demoMarker] * 1.02 + localRipple;
    return {
      wavenumber: row.wavenumber,
      intensity: Number(intensity.toFixed(6)),
    };
  });
  return {
    name: "内置示例光谱_Trp",
    sampleId: `SERS-DEMO-${Date.now().toString().slice(-6)}`,
    points,
    range: [points[0].wavenumber, points[points.length - 1].wavenumber],
  };
}

function computeQc(spectrum) {
  const values = spectrum.points.map((point) => point.intensity);
  const xs = spectrum.points.map((point) => point.wavenumber);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((acc, value) => acc + value, 0) / values.length;
  const variance = values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / values.length;
  const sd = Math.sqrt(variance);
  const span = max - min;
  const signalSpan = Math.abs(mean) > 1e-8 ? span / (Math.abs(mean) + 1e-8) : span;
  const edge = Math.max(5, Math.floor(values.length * 0.08));
  const leftMean = values.slice(0, edge).reduce((a, b) => a + b, 0) / edge;
  const rightMean = values.slice(-edge).reduce((a, b) => a + b, 0) / edge;
  const drift = Math.abs(leftMean - rightMean) / (span + 1e-8);
  const rangeOk = Math.min(...xs) <= 450 && Math.max(...xs) >= 1750;
  const complete = values.length >= 100 || (values.length >= 80 && rangeOk);
  const dynamicScore = Math.max(50, Math.min(100, 72 + signalSpan * 28));
  const baselineScore = Math.max(55, Math.min(100, 96 - drift * 120));
  const completenessScore = complete ? 100 : Math.max(50, values.length / 1.4);
  const overall = (dynamicScore * 0.35 + baselineScore * 0.35 + completenessScore * 0.2 + (rangeOk ? 100 : 72) * 0.1);
  return {
    min,
    max,
    mean,
    sd,
    signalSpan,
    validRange: rangeOk,
    complete,
    dynamicScore: Number(dynamicScore.toFixed(1)),
    baselineScore: Number(baselineScore.toFixed(1)),
    overall: Number(overall.toFixed(1)),
  };
}

function setUploadMessage(message, type = "normal") {
  const node = el("#upload-message");
  node.textContent = message;
  node.className = type === "error" ? "upload-error" : "";
}

function runAnalysis() {
  if (!state.uploadedSpectrum) {
    state.uploadedSpectrum = createDemoSpectrum(state.data);
    state.importResult = decorateImportResult({
      fileName: "内置示例光谱",
      layout: "demo-single-spectrum",
      layoutLabel: "示例单光谱",
      hasWavenumberAxis: true,
      labelColumns: [],
      candidates: [state.uploadedSpectrum],
    });
    state.selectedSpectrumIndex = 0;
    setUploadMessage("已载入内置示例光谱，可继续执行自动质控与分析。");
  }
  setInterpretation(state.importResult, state.selectedSpectrumIndex);
  state.qc = computeQc(state.uploadedSpectrum);
  state.pipeline.imported = true;
  state.pipeline.qc = state.qc.overall >= 70;
  state.analysisRequest = buildAsfnAnalysisRequest();
  state.analysisResponse = createAsfnAnalysisResponse(state.analysisRequest, state.rawData, state.qc);
  state.pipeline.analyzed = state.pipeline.qc && state.analysisResponse.status === "completed" && state.sampleInterpretation.type !== "mapping_conflict";
  state.pipeline.reported = state.pipeline.analyzed;
  state.reportStatus = state.pipeline.analyzed ? "待复核" : "质控复核";
  state.data = applyAnalysisResponse(state.rawData, state.uploadedSpectrum, state.analysisResponse);
  state.data.sample.reportStatus = state.reportStatus;
  addAnalysisHistory();
  const targetLabel = state.uploadedSpectrum.name;
  setUploadMessage(
    state.pipeline.analyzed
      ? `已完成 ${targetLabel} 的光谱解析、自动质控和分析结果生成。${state.sampleInterpretation.reportHint}`
      : state.qc.overall < 70
        ? "光谱质控未通过，建议检查文件范围、信号强度或基线漂移。"
        : state.sampleInterpretation.reportHint,
    state.pipeline.analyzed ? "normal" : "error",
  );
  renderAll();
  if (state.pipeline.analyzed) switchView("interpretation");
}

function bindEvents() {
  els(".nav-item").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  els(".stage-tab, [data-view-jump]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view || button.dataset.viewJump));
  });

  els(".tool-chip").forEach((button) => {
    button.addEventListener("click", () => {
      state.spectrumMode = button.dataset.spectrumMode;
      els(".tool-chip").forEach((item) => item.classList.toggle("active", item === button));
      renderSpectrumChart(state.data);
    });
  });

  el("#review-button").addEventListener("click", () => {
    state.reportStatus = "复核中";
    state.pipeline.reported = true;
    renderSampleStrip(state.data);
    renderReport(state.data);
    renderWorkflowList();
    els(".nav-item").find((item) => item.dataset.view === "report").click();
  });

  el("#report-button").addEventListener("click", () => {
    state.reportStatus = "待复核";
    state.pipeline.reported = true;
    renderSampleStrip(state.data);
    renderReport(state.data);
    renderWorkflowList();
    els(".nav-item").find((item) => item.dataset.view === "report").click();
  });

  el("#save-sample-info").addEventListener("click", saveSampleInfo);
  el("#export-json").addEventListener("click", exportAnalysisJson);
  el("#export-html").addEventListener("click", exportReportHtml);

  el("#choose-file").addEventListener("click", () => el("#spectrum-file").click());

  el("#spectrum-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      importSingleSpectrum(parseSpectrumText(text, file.name));
    } catch (error) {
      state.importError = error.message;
      state.importResult = null;
      state.uploadedSpectrum = null;
      state.qc = null;
      resetAnalysisState();
      setUploadMessage(error.message, "error");
      renderAll();
    } finally {
      event.target.value = "";
    }
  });

  el("#demo-spectrum").addEventListener("click", () => {
    const demo = createDemoSpectrum(state.rawData);
    importSingleSpectrum({
      fileName: "内置示例光谱",
      layout: "demo-single-spectrum",
      layoutLabel: "示例单光谱",
      hasWavenumberAxis: true,
      labelColumns: [],
      candidates: [demo],
    });
  });

  el("#run-analysis").addEventListener("click", runAnalysis);
  el("#run-analysis-spectrum").addEventListener("click", runAnalysis);
}

async function init() {
  try {
    const response = await fetch("./platform-data.json", { cache: "no-store" });
    state.data = await response.json();
    state.rawData = cloneData(state.data);
    state.reportStatus = state.data.sample.reportStatus;
    renderAll();
    bindEvents();
  } catch (error) {
    console.error(error);
    el("#top-title").textContent = "检测数据加载失败";
    el("#sample-strip").innerHTML = `<div class="sample-item"><span>提示</span><strong>请通过本地服务打开页面</strong></div>`;
  }
}

init();
