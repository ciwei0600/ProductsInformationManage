const state = {
  categories: [],
  categoryTree: [],
  page: 1,
  pageSize: 20,
  total: 0,
  selectedTreeCategoryId: null,
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
      setActivePage(link.dataset.page || links[0].dataset.page || "page-category-create");
    });
  });

  const applyByHash = () => {
    const hash = window.location.hash.replace("#", "");
    const matched = links.find((link) => link.dataset.page === hash);
    if (matched) {
      setActivePage(hash, false);
      return;
    }
    setActivePage(links[0].dataset.page || "page-category-create", false);
  };

  window.addEventListener("hashchange", applyByHash);
  applyByHash();
}

function categoryPathMap() {
  const byId = new Map();
  const children = new Map();

  for (const item of state.categories) {
    byId.set(item.id, item);
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
  if ([...select.options].some((o) => o.value === currentValue)) {
    select.value = currentValue;
  }
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
    item.addEventListener("click", async () => {
      const id = Number(item.dataset.id);
      state.selectedTreeCategoryId = id;
      el("filterCategory").value = String(id);
      state.page = 1;
      renderCategoryTree();
      await loadProducts();
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
      await Promise.all([loadProducts(), loadStats()]);
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

  container.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.id);
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

  renderCategoryTree();
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
  await request("/api/categories", {
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
  await Promise.all([loadCategories(), loadProducts()]);
}

async function deleteCategory() {
  const categoryId = el("manageCategoryId").value;
  if (!categoryId) throw new Error("请选择目录");
  if (!window.confirm("确认删除该目录？")) return;

  await request(`/api/categories/${categoryId}`, { method: "DELETE" });
  toast("目录已删除");
  await Promise.all([loadCategories(), loadProducts(), loadStats()]);
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
    await Promise.all([loadProducts(), loadStats(), loadProductDetail(Number(productId))]);
    return;
  }

  const created = await request("/api/products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  toast("产品已新增");
  await Promise.all([loadProducts(), loadStats()]);
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
    createCategory().catch((e) => toast(e.message))
  );
  el("renameCategoryBtn").addEventListener("click", () =>
    renameCategory().catch((e) => toast(e.message))
  );
  el("deleteCategoryBtn").addEventListener("click", () =>
    deleteCategory().catch((e) => toast(e.message))
  );

  el("searchBtn").addEventListener("click", () => {
    state.page = 1;
    loadProducts().catch((e) => toast(e.message));
  });

  el("searchKeyword").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      state.page = 1;
      loadProducts().catch((e) => toast(e.message));
    }
  });

  el("filterCategory").addEventListener("change", () => {
    state.selectedTreeCategoryId = el("filterCategory").value
      ? Number(el("filterCategory").value)
      : null;
    state.page = 1;
    renderCategoryTree();
    loadProducts().catch((e) => toast(e.message));
  });

  el("saveProductBtn").addEventListener("click", () =>
    saveProduct().catch((e) => toast(e.message))
  );
  el("resetProductBtn").addEventListener("click", resetProductForm);
  el("uploadImageBtn").addEventListener("click", () =>
    uploadImage().catch((e) => toast(e.message))
  );

  el("prevPageBtn").addEventListener("click", () => {
    if (state.page <= 1) return;
    state.page -= 1;
    loadProducts().catch((e) => toast(e.message));
  });

  el("nextPageBtn").addEventListener("click", () => {
    const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
    if (state.page >= totalPages) return;
    state.page += 1;
    loadProducts().catch((e) => toast(e.message));
  });
}

async function bootstrap() {
  bindEvents();
  initSideNavigation();
  resetProductForm();
  await Promise.all([loadCategories(), loadStats()]);
  await loadProducts();
}

bootstrap().catch((err) => {
  console.error(err);
  toast(err.message || "初始化失败");
});
