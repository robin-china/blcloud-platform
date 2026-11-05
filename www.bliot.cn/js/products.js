// 产品相关功能 - 修复版
class ProductManager {
    constructor() {
        this.initialized = false;
    }
    
    // 初始化
    async init() {
        // 等待配置加载完成
        await window.siteConfig.waitForInit();
        this.initialized = true;
        console.log('ProductManager 初始化完成');
    }
    
    // 初始化主页产品预览
    async initHomepageProducts() {
        if (!this.initialized) await this.init();
        
        const productsGrid = document.getElementById('productsGrid');
        const filterBtns = document.querySelectorAll('#productsFilter .filter-btn');
        
        if (!productsGrid) {
            console.error('未找到产品网格容器');
            return;
        }
        
        console.log('开始加载主页产品...');
        
        // 获取产品数据（首页只显示6个）
        const products = window.siteConfig.getProducts().slice(0, 6);
        console.log('获取到产品数据:', products);
        
        this.renderProducts(products, productsGrid);
        
        // 初始化筛选功能
        if (filterBtns.length > 0) {
            this.initFilter(productsGrid, filterBtns);
        }
    }
    
    // 初始化产品列表页
    async initProductListPage() {
        if (!this.initialized) await this.init();
        
        const productsGrid = document.getElementById('productsGrid');
        const filterBtns = document.querySelectorAll('#productsFilter .filter-btn');
        
        if (!productsGrid) {
            console.error('未找到产品网格容器');
            return;
        }
        
        console.log('开始加载产品列表页...');
        
        // 获取所有产品
        const products = window.siteConfig.getProducts();
        console.log('获取到产品数据:', products);
        
        this.renderProducts(products, productsGrid);
        
        // 初始化筛选功能
        if (filterBtns.length > 0) {
            this.initFilter(productsGrid, filterBtns);
        }
        
        // 检查URL参数
        const category = this.getQueryParam('category');
        if (category) {
            const targetBtn = document.querySelector(`.filter-btn[data-filter="${category}"]`);
            if (targetBtn) {
                setTimeout(() => targetBtn.click(), 100);
            }
        }
    }
    
    // 初始化产品详情页
    async initProductDetailPage() {
        if (!this.initialized) await this.init();
        
        const productId = this.getQueryParam('id');
        if (!productId) {
            this.showProductError('未指定产品ID');
            return;
        }
        
        console.log('开始加载产品详情，ID:', productId);
        
        // 获取产品数据
        const product = window.siteConfig.getProductById(productId);
        if (!product) {
            this.showProductError('产品不存在');
            return;
        }
        
        console.log('获取到产品详情:', product);
        
        // 渲染产品详情
        this.renderProductDetail(product);
        
        // 渲染相关产品
        this.renderRelatedProducts(productId);
    }
    
    // 渲染产品列表
    renderProducts(products, container) {
        if (!container) return;
        
        if (!products || products.length === 0) {
            container.innerHTML = `
                <div class="no-products" style="grid-column: 1/-1; text-align: center; padding: 50px;">
                    <i class="fas fa-box-open fa-3x" style="color: #ccc; margin-bottom: 20px;"></i>
                    <h3 style="color: #666; margin-bottom: 10px;">暂无产品</h3>
                    <p style="color: #999;">请稍后再来查看</p>
                </div>
            `;
            return;
        }
        
        let html = '';
        products.forEach(product => {
            html += this.createProductCard(product);
        });
        
        container.innerHTML = html;
    }
    
    // 创建产品卡片
    createProductCard(product) {
        if (!product) return '';
        
        const categoryName = window.siteConfig.getCategoryName(product.category);
        const features = product.features || [];
        const price = product.price || '价格面议';
        
        return `
            <div class="product-card" data-category="${product.category}">
                <div class="product-image">
                    <img src="${product.image}" alt="${product.name}" loading="lazy" 
                         onerror="this.src='images/noimage.jpg'">
                    <span class="product-category">${categoryName}</span>
                </div>
                <div class="product-content">
                    <h3>${product.name}</h3>
                    <div class="product-price">${price}</div>
                    <p class="product-description">${product.description}</p>
                    ${features.length > 0 ? `
                        <ul class="product-features">
                            ${features.map(feature => `<li>${feature}</li>`).join('')}
                        </ul>
                    ` : ''}
                    <a href="product-detail.html?id=${product.id}" class="btn btn-primary">查看详情</a>
                </div>
            </div>
        `;
    }
    
    // 初始化筛选功能
    initFilter(productsGrid, filterBtns) {
        filterBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                // 更新活动按钮
                filterBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                
                const filterValue = btn.getAttribute('data-filter');
                const productCards = productsGrid.querySelectorAll('.product-card');
                
                // 筛选产品
                let visibleCount = 0;
                productCards.forEach(card => {
                    if (filterValue === 'all' || card.getAttribute('data-category') === filterValue) {
                        card.style.display = 'block';
                        visibleCount++;
                    } else {
                        card.style.display = 'none';
                    }
                });
                
                // 显示无产品提示
                this.toggleNoProductsMessage(productsGrid, visibleCount === 0);
            });
        });
    }
    
    // 切换无产品提示
    toggleNoProductsMessage(container, show) {
        let message = container.querySelector('.no-products-filter');
        
        if (show && !message) {
            message = document.createElement('div');
            message.className = 'no-products-filter';
            message.style.cssText = 'grid-column: 1/-1; text-align: center; padding: 50px;';
            message.innerHTML = `
                <i class="fas fa-search fa-3x" style="color: #ccc; margin-bottom: 20px;"></i>
                <h3 style="color: #666; margin-bottom: 10px;">暂无此类产品</h3>
                <p style="color: #999;">请选择其他分类</p>
            `;
            container.appendChild(message);
        } else if (!show && message) {
            message.remove();
        }
    }
    
    // 渲染产品详情
    renderProductDetail(product) {
        const container = document.getElementById('productDetail');
        if (!container) return;
        
        const categoryName = window.siteConfig.getCategoryName(product.category);
        const specs = product.specs || {};
        const features = product.features || [];
        const price = product.price || '价格面议';
        
        container.innerHTML = `
            <div class="product-images">
                <div class="product-main-image">
                    <img src="${product.image}" alt="${product.name}" id="mainProductImage"
                         onerror="this.src='images/noimage.jpg">
                </div>
            </div>
            
            <div class="product-info">
                <span class="product-category-badge">${categoryName}</span>
                <h1>${product.name}</h1>
                <div class="product-price-large">${price}</div>
                <div class="product-description">
                    <p>${product.description}</p>
                </div>
                
                ${features.length > 0 ? `
                    <div class="product-features">
                        <h3>产品特性</h3>
                        <ul>
                            ${features.map(feature => `<li>${feature}</li>`).join('')}
                        </ul>
                    </div>
                ` : ''}
                
                ${Object.keys(specs).length > 0 ? `
                    <div class="product-specs">
                        <h3>产品规格</h3>
                        <table class="specs-table">
                            ${Object.entries(specs).map(([key, value]) => `
                                <tr>
                                    <td>${key}</td>
                                    <td>${value}</td>
                                </tr>
                            `).join('')}
                        </table>
                    </div>
                ` : ''}
                
                <div class="product-actions">
                    <a href="index.html#contact" class="btn btn-primary">咨询产品</a>
                    <a href="product-list.html" class="btn btn-outline">返回产品列表</a>
                </div>
            </div>
        `;
        
        // 更新页面标题
        document.title = `${product.name} | 天津佰莱科技有限公司 | bliot佰莱物联`;
        
        // 更新面包屑中的产品名
        const productNameElement = document.getElementById('productName');
        if (productNameElement) {
            productNameElement.textContent = product.name;
        }
    }
    
    // 渲染相关产品
    async renderRelatedProducts(currentProductId) {
        const container = document.getElementById('relatedProducts');
        if (!container) return;
        
        const relatedProducts = window.siteConfig.getRelatedProducts(currentProductId, 4);
        
        if (relatedProducts.length === 0) {
            const section = container.closest('.related-products-section');
            if (section) {
                section.style.display = 'none';
            }
            return;
        }
        
        let html = '';
        relatedProducts.forEach(product => {
            html += this.createProductCard(product);
        });
        
        container.innerHTML = html;
    }
    
    // 显示产品错误
    showProductError(message) {
        const container = document.getElementById('productDetail');
        if (!container) return;
        
        container.innerHTML = `
            <div style="grid-column: 1/-1; text-align: center; padding: 100px 0;">
                <i class="fas fa-exclamation-triangle fa-3x" style="color: #ffc107; margin-bottom: 20px;"></i>
                <h3 style="color: #666; margin-bottom: 20px;">${message}</h3>
                <p style="color: #999; margin-bottom: 30px;">请返回产品列表选择其他产品</p>
                <a href="product-list.html" class="btn btn-primary">返回产品列表</a>
            </div>
        `;
    }
    
    // 获取URL参数
    getQueryParam(name) {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get(name);
    }
}

// 创建全局实例
window.productManager = new ProductManager();

// 为全局提供函数（兼容旧代码）
function initHomepageProducts() {
    console.log('调用 initHomepageProducts');
    window.productManager.initHomepageProducts().catch(error => {
        console.error('初始化主页产品失败:', error);
    });
}

function initProductListPage() {
    console.log('调用 initProductListPage');
    window.productManager.initProductListPage().catch(error => {
        console.error('初始化产品列表页失败:', error);
    });
}

function initProductDetailPage() {
    console.log('调用 initProductDetailPage');
    window.productManager.initProductDetailPage().catch(error => {
        console.error('初始化产品详情页失败:', error);
    });
}

// 自动初始化
document.addEventListener('DOMContentLoaded', () => {
    console.log('页面加载完成，开始初始化产品管理器...');
    
    // 根据当前页面调用对应的初始化函数
    const path = window.location.pathname;
    
    if (path.includes('product-detail.html')) {
        // 产品详情页
        initProductDetailPage();
    } else if (path.includes('product-list.html')) {
        // 产品列表页
        initProductListPage();
    } else {
        // 首页
        // 延迟执行，确保DOM完全加载
        setTimeout(() => {
            initHomepageProducts();
        }, 100);
    }
});