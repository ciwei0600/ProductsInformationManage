const state = {
  categories: [],
  categoryTree: [],
  page: 1,
  pageSize: 20,
  total: 0,
  selectedTreeCategoryId: null,
  categoryAction: "add",
  materialProducts: [],
  quoteLines: [],
};

function el(id) {
  return document.getElementById(id);
}

function toast(message) {
  const node = el("toast");
  node.textContent = message;
  node.classList.add("show");
  window.setTimeout(() => node.classList.remove("show"), 2200);
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "请求失败");
  }
  return data;
}

function parseFirstNumber(value) {
  const text = String(value || "").trim();
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractUnit(value, defaultUnit = "") {
  const text = String(value || "").trim();
  if (!text) return defaultUnit;
  const unit = text.replace(/-?\d+(?:\.\d+)?/g, "").trim();
  return unit || defaultUnit;
}

function toMoney(value) {
  if (!Number.isFinite(value)) return "-";
  return value.toFixed(2);
}

function setText(id, value) {
  el(id).textContent = value;
}

function productDisplayName(product) {
  const name = product.chinese_name || product.name || "";
  return `${product.code} | ${name}`;
}

function getMaterialProductById(rawId) {
  const id = Number(rawId);
  if (!id) return null;
  return state.materialProducts.find((item) => item.id === id) || null;
}

function fillMaterialProductSelect(selectId, placeholder = "请选择产品") {
  const select = el(selectId);
  if (!select) return;

  const currentValue = select.value;
  let html = `<option value="">${placeholder}</option>`;
  for (const item of state.materialProducts) {
    html += `<option value="${item.id}">${productDisplayName(item)}</option>`;
  }

  select.innerHTML = html;
  if ([...select.options].some((option) => option.value === currentValue)) {
    select.value = currentValue;
    return;
  }

  if (state.materialProducts.length > 0) {
    select.value = String(state.materialProducts[0].id);
  }
}

function setActivePage(pageId, updateHash = true) {
  const target = document.getElementById(pageId);
  if (!target) return;

  document.querySelectorAll(".nav-level2[data-page]").forEach((link) => {
    link.classList.toggle("active", link.dataset.page === pageId);
  });
  document.querySelectorAll(".content-page").forEach((page) => {
    page.classList.toggle("active", page.id === pageId);
  });

  if (updateHash && window.location.hash !== `#${pageId}`) {
    window.history.replaceState(null, "", `#${pageId}`);
  }
}

function initSideNavigation() {
  const links = [...document.querySelectorAll(".nav-level2[data-page]")];
  if (!links.length) return;

  links.forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      setActivePage(link.dataset.page || links[0].dataset.page || "page-category-manage");
    });
  });

  const applyByHash = () => {
    const hash = window.location.hash.replace("#", "");
    const matched = links.find((link) => link.dataset.page === hash);
    if (matched) {
      setActivePage(hash, false);
      return;
    }
    setActivePage(links[0].dataset.page || "page-category-manage", false);
  };

  window.addEventListener("hashchange", applyByHash);
  applyByHash();
}

function categoryPathMap() {
  const children = new Map();

  for (const item of state.categories) {
    if (!children.has(item.parent_id ?? 0)) {
      children.set(item.parent_id ?? 0, []);
    }
    children.get(item.parent_id ?? 0).push(item);
  }

  const result = new Map();

  function walk(parentId, prefix) {
    const list = children.get(parentId) || [];
    for (const item of list) {
      const path = prefix ? `${prefix} / ${item.name}` : item.name;
      result.set(item.id, path);
      walk(item.id, path);
    }
  }

  walk(0, "");
  return result;
}

function fillCategorySelect(selectId, includeAll = false) {
  const select = el(selectId);
  const pathMap = categoryPathMap();
  const currentValue = select.value;

  let html = "";
  if (includeAll) {
    html += '<option value="">全部目录</option>';
  } else {
    html += '<option value="">无</option>';
  }

  for (const category of state.categories) {
    const path = pathMap.get(category.id) || category.name;
    html += `<option value="${category.id}">${path}</option>`;
  }

  select.innerHTML = html;
  if ([...select.options].some((option) => option.value === currentValue)) {
    select.value = currentValue;
  }
}

function setCategoryAction(action) {
  const allowRenameDelete = Boolean(el("manageCategoryId").value);
  const finalAction = !allowRenameDelete && action !== "add" ? "add" : action;
  state.categoryAction = finalAction;

  document.querySelectorAll("[data-category-action]").forEach((button) => {
    const active = button.dataset.categoryAction === finalAction;
    button.classList.toggle("active", active);
  });
  document.querySelectorAll("[data-category-panel]").forEach((panel) => {
    const active = panel.dataset.categoryPanel === finalAction;
    panel.classList.toggle("active", active);
  });
}

function updateCategorySelectionHint() {
  const selectedId = Number(el("manageCategoryId").value);
  const pathMap = categoryPathMap();
  const path = selectedId ? pathMap.get(selectedId) || `目录 #${selectedId}` : "";
  const hint = selectedId
    ? `已选择目录：${path}。可在上方切换新增/修改/删除功能。`
    : "未选择目录。可直接新增一级目录。";
  setText("categorySelectedHint", hint);

  document.querySelectorAll("[data-category-action='rename'], [data-category-action='delete']").forEach((button) => {
    button.disabled = !selectedId;
  });

  if (!selectedId && state.categoryAction !== "add") {
    setCategoryAction("add");
  }
}

function renderCategoryProductsPreview(items) {
  const body = el("categoryProductsBody");
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="5" class="hint">该目录下暂无产品</td></tr>';
    return;
  }

  body.innerHTML = items
    .map((item) => {
      const name = item.chinese_name || item.name || "-";
      return `
      <tr>
        <td>${item.code || "-"}</td>
        <td>${name}</td>
        <td>${item.effect || "-"}</td>
        <td>${item.package_quantity || "-"}</td>
        <td>${item.gross_weight || "-"}</td>
      </tr>
      `;
    })
    .join("");
}

async function refreshCategoryProductsPreview() {
  const selectedId = Number(el("manageCategoryId").value);
  if (!selectedId) {
    setText("categoryProductsSummary", "请选择目录查看产品");
    renderCategoryProductsPreview([]);
    return;
  }

  const items = await fetchAllProducts({ categoryId: selectedId });
  setText("categoryProductsSummary", `当前目录下共 ${items.length} 个产品（含子目录）`);
  renderCategoryProductsPreview(items);
}

function renderCategoryTree() {
  const container = el("categoryTree");

  function renderNodes(nodes, depth = 0) {
    let html = "";
    for (const node of nodes) {
      const active = state.selectedTreeCategoryId === node.id ? "active" : "";
      const padding = 10 + depth * 14;
      html += `<li>
        <div class="tree-item ${active}" data-id="${node.id}" style="padding-left:${padding}px">${node.name}</div>
      `;
      if (node.children && node.children.length > 0) {
        html += `<ul class="tree">${renderNodes(node.children, depth + 1)}</ul>`;
      }
      html += "</li>";
    }
    return html;
  }

  container.innerHTML = renderNodes(state.categoryTree);

  container.querySelectorAll(".tree-item").forEach((item) => {
    item.addEventListener("click", () => {
      const id = Number(item.dataset.id);
      state.selectedTreeCategoryId = id;
      el("manageCategoryId").value = String(id);
      el("newCategoryParent").value = String(id);
      updateCategorySelectionHint();
      renderCategoryTree();
      refreshCategoryProductsPreview().catch((err) => toast(err.message));
    });
  });
}

function renderProducts(items) {
  const body = el("productsBody");
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="11" class="hint">暂无数据</td></tr>';
    return;
  }

  body.innerHTML = items
    .map((item) => {
      const chineseName = item.chinese_name || item.name || "-";
      const img = item.first_image
        ? `<img class="thumb" src="/media/${item.first_image}" alt="${chineseName}" />`
        : '<span class="hint">无图</span>';
      return `
      <tr>
        <td>${item.code}</td>
        <td>${chineseName}</td>
        <td>${item.effect || "-"}</td>
        <td>${item.spray_radius || "-"}</td>
        <td>${item.unit_weight || "-"}</td>
        <td>${item.package_quantity || "-"}</td>
        <td>${item.package_size || "-"}</td>
        <td>${item.gross_weight || "-"}</td>
        <td>${item.category_name || "-"}</td>
        <td>${img}<div class="hint">共 ${item.image_count} 张</div></td>
        <td>
          <div class="button-row">
            <button data-action="edit" data-id="${item.id}">编辑</button>
            <button class="danger" data-action="delete" data-id="${item.id}">删除</button>
          </div>
        </td>
      </tr>
      `;
    })
    .join("");

  body.querySelectorAll("button[data-action='edit']").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = Number(button.dataset.id);
      await loadProductDetail(id);
    });
  });

  body.querySelectorAll("button[data-action='delete']").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = Number(button.dataset.id);
      if (!window.confirm("确认删除该产品？")) return;
      await request(`/api/products/${id}`, { method: "DELETE" });
      toast("产品已删除");
      if (String(el("productId").value) === String(id)) {
        resetProductForm();
      }
      await Promise.all([loadProducts(), loadStats(), loadMaterialProducts()]);
    });
  });
}

function updatePager() {
  const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
  el("pageInfo").textContent = `第 ${state.page} / ${totalPages} 页`;
  el("prevPageBtn").disabled = state.page <= 1;
  el("nextPageBtn").disabled = state.page >= totalPages;
}

function renderProductImages(images) {
  const container = el("imageList");
  if (!images.length) {
    container.innerHTML = '<div class="hint">暂无图片</div>';
    return;
  }

  container.innerHTML = images
    .map(
      (img) => `
    <div class="image-card">
      <img src="/media/${img.image_path}" alt="${img.image_path}" />
      <button class="danger" data-id="${img.id}">删除图片</button>
    </div>
  `
    )
    .join("");

  container.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = Number(button.dataset.id);
      if (!window.confirm("确认删除该图片？")) return;
      await request(`/api/product-images/${id}`, { method: "DELETE" });
      toast("图片已删除");
      const productId = Number(el("productId").value);
      if (productId) {
        await Promise.all([loadProductDetail(productId), loadProducts(), loadStats()]);
      }
    });
  });
}

function resetProductForm() {
  el("productId").value = "";
  el("productCode").value = "";
  el("productChineseName").value = "";
  el("productCategory").value = "";
  el("productEffect").value = "";
  el("productDescription").value = "";
  el("productSprayRadius").value = "";
  el("productUnitWeight").value = "";
  el("productPackageQuantity").value = "";
  el("productPackageSize").value = "";
  el("productGrossWeight").value = "";
  el("productFormTitle").textContent = "新增产品";
  el("imageFile").value = "";
  el("imageList").innerHTML = '<div class="hint">请先选择或保存一个产品后上传图片。</div>';
}

function resetMaterialPanels() {
  setText("paramCode", "-");
  setText("paramName", "-");
  setText("paramSprayArea", "-");
  setText("paramNetWeight", "-");
  setText("paramPerPackageQty", "-");
  setText("paramPackageCount", "-");

  setText("costPackageCount", "-");
  setText("costSubtotal", "-");
  setText("costQuoteExTax", "-");
  setText("costQuoteInclTax", "-");
  setText("costUnitExTax", "-");
  setText("costUnitInclTax", "-");

  renderMaterialPackageTable([]);
  renderQuoteLines();
}

async function loadStats() {
  const stats = await request("/api/stats");
  el("stats").textContent = `目录: ${stats.categories} | 产品: ${stats.products} | 图片: ${stats.images}`;
}

async function loadCategories() {
  const data = await request("/api/categories");
  state.categories = data.items;
  state.categoryTree = data.tree;

  fillCategorySelect("newCategoryParent");
  fillCategorySelect("manageCategoryId");
  fillCategorySelect("filterCategory", true);
  fillCategorySelect("productCategory");
  fillCategorySelect("materialPackageCategory", true);

  if (el("newCategoryParent").options.length > 0) {
    el("newCategoryParent").options[0].textContent = "一级目录";
  }
  if (el("manageCategoryId").options.length > 0) {
    el("manageCategoryId").options[0].textContent = "请选择目录";
  }

  const selectedId = Number(el("manageCategoryId").value);
  state.selectedTreeCategoryId = selectedId || null;
  updateCategorySelectionHint();

  renderCategoryTree();
  await refreshCategoryProductsPreview();
}

async function loadProducts() {
  const keyword = el("searchKeyword").value.trim();
  const categoryId = el("filterCategory").value;

  const params = new URLSearchParams({
    page: String(state.page),
    page_size: String(state.pageSize),
  });

  if (keyword) params.set("q", keyword);
  if (categoryId) params.set("category_id", categoryId);

  const data = await request(`/api/products?${params.toString()}`);
  state.total = data.total;
  renderProducts(data.items);
  updatePager();
}

async function fetchAllProducts(options = {}) {
  const keyword = (options.keyword || "").trim();
  const categoryId = options.categoryId || "";
  const items = [];
  const pageSize = 100;
  let page = 1;
  let total = 0;

  do {
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
    });
    if (keyword) params.set("q", keyword);
    if (categoryId) params.set("category_id", String(categoryId));

    const data = await request(`/api/products?${params.toString()}`);
    items.push(...(data.items || []));
    total = Number(data.total || 0);
    page += 1;
  } while (items.length < total);

  return items;
}

function renderMaterialPackageTable(items) {
  const body = el("materialPackageBody");
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="7" class="hint">暂无数据</td></tr>';
    setText("materialPackageSummary", "共 0 个产品");
    return;
  }

  body.innerHTML = items
    .map((item) => {
      const name = item.chinese_name || item.name || "-";
      return `
      <tr>
        <td>${item.code || "-"}</td>
        <td>${name}</td>
        <td>${item.package_quantity || "-"}</td>
        <td>${item.package_size || "-"}</td>
        <td>${item.unit_weight || "-"}</td>
        <td>${item.gross_weight || "-"}</td>
        <td>${item.category_name || "-"}</td>
      </tr>
      `;
    })
    .join("");

  setText("materialPackageSummary", `共 ${items.length} 个产品`);
}

function refreshMaterialSelectors() {
  fillMaterialProductSelect("materialParamProduct");
  fillMaterialProductSelect("materialCostProduct");
  fillMaterialProductSelect("quoteProduct");
}

async function refreshMaterialPackagingByFilter() {
  const keyword = el("materialPackageKeyword").value.trim();
  const categoryId = el("materialPackageCategory").value;

  if (!keyword && !categoryId) {
    renderMaterialPackageTable(state.materialProducts);
    return;
  }

  const items = await fetchAllProducts({ keyword, categoryId });
  renderMaterialPackageTable(items);
}

async function loadMaterialProducts() {
  state.materialProducts = await fetchAllProducts();
  refreshMaterialSelectors();
  await refreshMaterialPackagingByFilter();
}

function calculateMaterialParams() {
  const product = getMaterialProductById(el("materialParamProduct").value);
  if (!product) {
    throw new Error("请选择产品");
  }

  const quantity = Number(el("materialParamQuantity").value);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error("数量必须大于 0");
  }

  const packageQty = parseFirstNumber(product.package_quantity);
  const unitWeight = parseFirstNumber(product.unit_weight);
  const radius = parseFirstNumber(product.spray_radius);

  setText("paramCode", product.code || "-");
  setText("paramName", product.chinese_name || product.name || "-");
  setText("paramPerPackageQty", packageQty != null ? String(packageQty) : product.package_quantity || "-");

  if (packageQty != null && packageQty > 0) {
    setText("paramPackageCount", `${Math.ceil(quantity / packageQty)} 箱`);
  } else {
    setText("paramPackageCount", "-");
  }

  if (unitWeight != null) {
    const weightUnit = extractUnit(product.unit_weight, "");
    setText("paramNetWeight", `${(unitWeight * quantity).toFixed(2)}${weightUnit}`);
  } else {
    setText("paramNetWeight", "-");
  }

  if (radius != null && radius > 0) {
    const area = Math.PI * radius * radius * quantity;
    setText("paramSprayArea", `${area.toFixed(2)} m²`);
  } else {
    setText("paramSprayArea", "-");
  }
}

function calculateMaterialCost() {
  const product = getMaterialProductById(el("materialCostProduct").value);
  if (!product) {
    throw new Error("请选择产品");
  }

  const quantity = Number(el("materialCostQuantity").value);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error("数量必须大于 0");
  }

  const unitCost = Number(el("materialCostUnit").value);
  const packageCost = Number(el("materialCostPack").value);
  const freightCost = Number(el("materialCostFreight").value);
  const taxRate = Number(el("materialCostTaxRate").value) / 100;
  const profitRate = Number(el("materialCostProfitRate").value) / 100;

  const packageQty = parseFirstNumber(product.package_quantity);
  const packageCount = packageQty && packageQty > 0 ? Math.ceil(quantity / packageQty) : 0;

  const materialTotal = quantity * (Number.isFinite(unitCost) ? unitCost : 0);
  const packageTotal = packageCount * (Number.isFinite(packageCost) ? packageCost : 0);
  const freightTotal = packageCount * (Number.isFinite(freightCost) ? freightCost : 0);
  const subtotal = materialTotal + packageTotal + freightTotal;

  const quoteExTax = subtotal * (1 + (Number.isFinite(profitRate) ? profitRate : 0));
  const quoteInclTax = quoteExTax * (1 + (Number.isFinite(taxRate) ? taxRate : 0));
  const unitExTax = quoteExTax / quantity;
  const unitInclTax = quoteInclTax / quantity;

  setText("costPackageCount", `${packageCount} 箱`);
  setText("costSubtotal", `¥${toMoney(subtotal)}`);
  setText("costQuoteExTax", `¥${toMoney(quoteExTax)}`);
  setText("costQuoteInclTax", `¥${toMoney(quoteInclTax)}`);
  setText("costUnitExTax", `¥${toMoney(unitExTax)}`);
  setText("costUnitInclTax", `¥${toMoney(unitInclTax)}`);
}

function renderQuoteLines() {
  const body = el("quoteLinesBody");
  if (!state.quoteLines.length) {
    body.innerHTML = '<tr><td colspan="6" class="hint">暂无报价行</td></tr>';
    setText("quoteTotal", "总数量: 0 | 报价总额: 0.00");
    return;
  }

  body.innerHTML = state.quoteLines
    .map(
      (line) => `
      <tr>
        <td>${line.code}</td>
        <td>${line.name}</td>
        <td>${line.quantity}</td>
        <td>${toMoney(line.unitPrice)}</td>
        <td>${toMoney(line.amount)}</td>
        <td><button class="danger" data-remove-line="${line.id}">删除</button></td>
      </tr>
    `
    )
    .join("");

  body.querySelectorAll("button[data-remove-line]").forEach((button) => {
    button.addEventListener("click", () => {
      const lineId = Number(button.dataset.removeLine);
      state.quoteLines = state.quoteLines.filter((line) => line.id !== lineId);
      renderQuoteLines();
    });
  });

  const totalQuantity = state.quoteLines.reduce((sum, line) => sum + line.quantity, 0);
  const totalAmount = state.quoteLines.reduce((sum, line) => sum + line.amount, 0);
  setText("quoteTotal", `总数量: ${totalQuantity} | 报价总额: ${toMoney(totalAmount)}`);
}

function addQuoteLine() {
  const product = getMaterialProductById(el("quoteProduct").value);
  if (!product) throw new Error("请选择产品");

  const quantity = Number(el("quoteQty").value);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error("数量必须大于 0");
  }

  const unitPrice = Number(el("quoteUnitPrice").value);
  if (!Number.isFinite(unitPrice) || unitPrice < 0) {
    throw new Error("单价不能小于 0");
  }

  state.quoteLines.push({
    id: Date.now() + Math.floor(Math.random() * 1000),
    productId: product.id,
    code: product.code || "-",
    name: product.chinese_name || product.name || "-",
    quantity,
    unitPrice,
    amount: quantity * unitPrice,
  });

  renderQuoteLines();
}

function clearQuoteLines() {
  state.quoteLines = [];
  renderQuoteLines();
}

async function loadProductDetail(id) {
  const data = await request(`/api/products/${id}`);
  const product = data.product;
  setActivePage("page-product-form", true);

  el("productId").value = String(product.id);
  el("productCode").value = product.code || "";
  el("productChineseName").value = product.chinese_name || product.name || "";
  el("productCategory").value = product.category_id == null ? "" : String(product.category_id);
  el("productEffect").value = product.effect || "";
  el("productDescription").value = product.description || "";
  el("productSprayRadius").value = product.spray_radius || "";
  el("productUnitWeight").value = product.unit_weight || "";
  el("productPackageQuantity").value = product.package_quantity || "";
  el("productPackageSize").value = product.package_size || "";
  el("productGrossWeight").value = product.gross_weight || "";
  el("productFormTitle").textContent = `编辑产品 #${product.id}`;

  renderProductImages(data.images || []);
}

async function createCategory() {
  const name = el("newCategoryName").value.trim();
  const parentId = el("newCategoryParent").value;
  const created = await request("/api/categories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      parent_id: parentId ? Number(parentId) : null,
    }),
  });
  el("newCategoryName").value = "";
  toast("目录已新增");
  await Promise.all([loadCategories(), loadProducts(), loadStats()]);

  if (created && created.id) {
    const idText = String(created.id);
    el("manageCategoryId").value = idText;
    el("newCategoryParent").value = idText;
    state.selectedTreeCategoryId = created.id;
    updateCategorySelectionHint();
    renderCategoryTree();
  }
}

async function renameCategory() {
  const categoryId = el("manageCategoryId").value;
  const name = el("renameCategoryName").value.trim();
  if (!categoryId) throw new Error("请选择目录");

  await request(`/api/categories/${categoryId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });

  el("renameCategoryName").value = "";
  toast("目录已重命名");
  await Promise.all([loadCategories(), loadProducts(), loadMaterialProducts()]);
  updateCategorySelectionHint();
}

async function deleteCategory() {
  const categoryId = el("manageCategoryId").value;
  if (!categoryId) throw new Error("请选择目录");
  if (!window.confirm("确认删除该目录？")) return;

  await request(`/api/categories/${categoryId}`, { method: "DELETE" });
  toast("目录已删除");
  await Promise.all([loadCategories(), loadProducts(), loadStats(), loadMaterialProducts()]);
  updateCategorySelectionHint();
}

async function saveProduct() {
  const productId = el("productId").value;
  const payload = {
    code: el("productCode").value.trim(),
    chinese_name: el("productChineseName").value.trim(),
    category_id: el("productCategory").value ? Number(el("productCategory").value) : null,
    effect: el("productEffect").value.trim(),
    description: el("productDescription").value.trim(),
    spray_radius: el("productSprayRadius").value.trim(),
    unit_weight: el("productUnitWeight").value.trim(),
    package_quantity: el("productPackageQuantity").value.trim(),
    package_size: el("productPackageSize").value.trim(),
    gross_weight: el("productGrossWeight").value.trim(),
  };

  if (productId) {
    await request(`/api/products/${productId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    toast("产品已更新");
    await Promise.all([loadProducts(), loadStats(), loadMaterialProducts()]);
    await loadProductDetail(Number(productId));
    return;
  }

  const created = await request("/api/products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  toast("产品已新增");
  await Promise.all([loadProducts(), loadStats(), loadMaterialProducts()]);
  await loadProductDetail(created.id);
}

async function uploadImage() {
  const productId = el("productId").value;
  if (!productId) throw new Error("请先选择或保存一个产品");

  const fileInput = el("imageFile");
  if (!fileInput.files || fileInput.files.length === 0) {
    throw new Error("请选择要上传的图片");
  }

  const form = new FormData();
  form.append("image", fileInput.files[0]);

  await request(`/api/products/${productId}/images`, {
    method: "POST",
    body: form,
  });

  fileInput.value = "";
  toast("图片上传成功");
  await Promise.all([loadProductDetail(Number(productId)), loadProducts(), loadStats()]);
}

function bindEvents() {
  el("createCategoryBtn").addEventListener("click", () =>
    createCategory().catch((err) => toast(err.message))
  );
  el("renameCategoryBtn").addEventListener("click", () =>
    renameCategory().catch((err) => toast(err.message))
  );
  el("deleteCategoryBtn").addEventListener("click", () =>
    deleteCategory().catch((err) => toast(err.message))
  );
  el("manageCategoryId").addEventListener("change", () => {
    const selectedValue = el("manageCategoryId").value;
    state.selectedTreeCategoryId = selectedValue ? Number(selectedValue) : null;
    if (selectedValue) {
      el("newCategoryParent").value = selectedValue;
    }
    updateCategorySelectionHint();
    renderCategoryTree();
    refreshCategoryProductsPreview().catch((err) => toast(err.message));
  });
  document.querySelectorAll("[data-category-action]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled) return;
      setCategoryAction(button.dataset.categoryAction || "add");
    });
  });

  el("searchBtn").addEventListener("click", () => {
    state.page = 1;
    loadProducts().catch((err) => toast(err.message));
  });

  el("searchKeyword").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      state.page = 1;
      loadProducts().catch((err) => toast(err.message));
    }
  });

  el("filterCategory").addEventListener("change", () => {
    state.page = 1;
    loadProducts().catch((err) => toast(err.message));
  });

  el("saveProductBtn").addEventListener("click", () =>
    saveProduct().catch((err) => toast(err.message))
  );
  el("resetProductBtn").addEventListener("click", resetProductForm);
  el("uploadImageBtn").addEventListener("click", () =>
    uploadImage().catch((err) => toast(err.message))
  );

  el("prevPageBtn").addEventListener("click", () => {
    if (state.page <= 1) return;
    state.page -= 1;
    loadProducts().catch((err) => toast(err.message));
  });

  el("nextPageBtn").addEventListener("click", () => {
    const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
    if (state.page >= totalPages) return;
    state.page += 1;
    loadProducts().catch((err) => toast(err.message));
  });

  el("calcParamBtn").addEventListener("click", () => {
    try {
      calculateMaterialParams();
    } catch (err) {
      toast(err.message);
    }
  });

  el("materialPackageSearchBtn").addEventListener("click", () =>
    refreshMaterialPackagingByFilter().catch((err) => toast(err.message))
  );
  el("materialPackageKeyword").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      refreshMaterialPackagingByFilter().catch((err) => toast(err.message));
    }
  });
  el("materialPackageCategory").addEventListener("change", () =>
    refreshMaterialPackagingByFilter().catch((err) => toast(err.message))
  );

  el("calcCostBtn").addEventListener("click", () => {
    try {
      calculateMaterialCost();
    } catch (err) {
      toast(err.message);
    }
  });

  el("addQuoteLineBtn").addEventListener("click", () => {
    try {
      addQuoteLine();
    } catch (err) {
      toast(err.message);
    }
  });
  el("clearQuoteBtn").addEventListener("click", () => {
    if (!state.quoteLines.length) return;
    if (!window.confirm("确认清空报价单？")) return;
    clearQuoteLines();
  });
}

async function bootstrap() {
  bindEvents();
  setCategoryAction("add");
  updateCategorySelectionHint();
  initSideNavigation();
  resetProductForm();
  resetMaterialPanels();
  el("quoteDate").value = new Date().toISOString().slice(0, 10);

  await Promise.all([loadCategories(), loadStats()]);
  await Promise.all([loadProducts(), loadMaterialProducts()]);
}

bootstrap().catch((err) => {
  console.error(err);
  toast(err.message || "初始化失败");
});
