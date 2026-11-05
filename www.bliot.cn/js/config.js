// 配置文件管理 - 修复版
class SiteConfig {
    constructor() {
        this.config = null;
        this.initialized = false;
        this.initCallbacks = [];
        this.retryCount = 0;
        this.maxRetries = 3;
    }
    
    // 初始化配置
    async init() {
        try {
            console.log('开始加载配置文件...');
            
            // 尝试从多个路径加载配置
            let response = null;
            const possiblePaths = [
                'config/config.json',
                '/config/config.json',
                './config/config.json',
                '../config/config.json'
            ];
            
            for (const path of possiblePaths) {
                try {
                    console.log(`尝试从 ${path} 加载配置...`);
                    response = await fetch(path);
                    if (response.ok) break;
                } catch (e) {
                    console.log(`路径 ${path} 加载失败:`, e.message);
                }
            }
            
            if (!response || !response.ok) {
                throw new Error(`所有配置路径都加载失败`);
            }
            
            this.config = await response.json();
            console.log('配置加载成功:', this.config);
            
            // 验证配置结构
            this.validateConfigStructure();
            
            this.initialized = true;
            
            // 执行所有等待的回调
            this.initCallbacks.forEach(callback => callback());
            this.initCallbacks = [];
            
        } catch (error) {
            console.error('配置加载失败:', error);
            
            if (this.retryCount < this.maxRetries) {
                this.retryCount++;
                console.log(`第 ${this.retryCount} 次重试...`);
                setTimeout(() => this.init(), 1000);
                return;
            }
            
            // 重试失败后使用默认配置
            console.log('使用默认配置...');
            this.config = this.getDefaultConfig();
            this.initialized = true;
            
            // 执行所有等待的回调
            this.initCallbacks.forEach(callback => callback());
            this.initCallbacks = [];
        }
    }
    
    // 验证配置结构
    validateConfigStructure() {
        if (!this.config.company) {
            console.warn('配置缺少 company 字段，使用默认值');
            this.config.company = this.getDefaultConfig().company;
        }
        
        if (!this.config.products) {
            console.warn('配置缺少 products 字段，使用默认值');
            this.config.products = this.getDefaultConfig().products;
        }
        
        // 确保必要字段存在
        const requiredCompanyFields = ['name', 'brand', 'address', 'phone', 'email'];
        requiredCompanyFields.forEach(field => {
            if (!this.config.company[field]) {
                console.warn(`公司信息缺少 ${field} 字段`);
                this.config.company[field] = '';
            }
        });
        
        console.log('配置结构验证完成:', this.config);
    }
    
    // 获取默认配置
    getDefaultConfig() {
        return {
            company: {
                name: "天津佰莱科技有限公司",
                brand: "bliot佰莱物联",
                address: "天津市滨海新区经济技术开发区科技园15号楼3层",
                phone: "022-12345678",
                servicePhone: "400-888-9999",
                email: "info@bliot-tech.com",
                workHours: "周一至周五 9:00-18:00",
                copyright: "© 2023 天津佰莱科技有限公司 版权所有",
                beian: "津ICP备12345678号-1"
            },
            products: {
                categories: [
                    {id: "all", name: "全部产品"},
                    {id: "industrial", name: "工业物联网"},
                    {id: "elevator", name: "电梯物联网"},
                    {id: "sensor", name: "传感器"},
                    {id: "software", name: "软件平台"}
                ],
                items: [
                    {
                        id: 1,
                        name: "BLIOT-GW2000工业物联网网关",
                        category: "industrial",
                        price: "¥ 3,850.00",
                        description: "高性能工业物联网网关，支持多种工业协议转换，具备边缘计算能力和安全通信功能。",
                        features: ["支持多种通信方式", "边缘计算能力", "工业级设计"],
                        image: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?ixlib=rb-4.0.3&auto=format&fit=crop&w=600&q=80"
                    },
                    {
                        id: 2,
                        name: "BLIOT-EM100电梯物联网监测终端",
                        category: "elevator",
                        price: "¥ 2,980.00",
                        description: "专为电梯设计的物联网监测终端，实时采集电梯运行数据。",
                        features: ["实时监测", "故障预警", "符合标准"],
                        image: "https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?ixlib=rb-4.0.3&auto=format&fit=crop&w=600&q=80"
                    }
                ]
            }
        };
    }
    
    // 等待配置初始化
    async waitForInit() {
        if (this.initialized) {
            return Promise.resolve();
        }
        
        return new Promise((resolve) => {
            this.initCallbacks.push(resolve);
        });
    }
    
    // 获取公司信息
    getCompanyInfo() {
        return this.config?.company || this.getDefaultConfig().company;
    }
    
    // 获取产品分类
    getProductCategories() {
        return this.config?.products?.categories || this.getDefaultConfig().products.categories;
    }
    
    // 获取所有产品
    getProducts() {
        return this.config?.products?.items || this.getDefaultConfig().products.items;
    }
    
    // 根据ID获取产品
    getProductById(id) {
        const products = this.getProducts();
        const productId = parseInt(id);
        return products.find(product => product.id === productId);
    }
    
    // 根据分类获取产品
    getProductsByCategory(categoryId) {
        const products = this.getProducts();
        if (categoryId === 'all') return products;
        return products.filter(product => product.category === categoryId);
    }
    
    // 获取相关产品
    getRelatedProducts(currentProductId, limit = 4) {
        const currentProduct = this.getProductById(currentProductId);
        if (!currentProduct) return [];
        
        const products = this.getProducts();
        const sameCategoryProducts = products.filter(p => 
            p.category === currentProduct.category && p.id != currentProductId
        );
        
        // 如果同类别产品不足，补充其他产品
        if (sameCategoryProducts.length < limit) {
            const otherProducts = products.filter(p => 
                p.category !== currentProduct.category && p.id != currentProductId
            ).slice(0, limit - sameCategoryProducts.length);
            return [...sameCategoryProducts, ...otherProducts];
        }
        
        return sameCategoryProducts.slice(0, limit);
    }
    
    // 获取分类名称
    getCategoryName(categoryId) {
        const categories = this.getProductCategories();
        const category = categories.find(cat => cat.id === categoryId);
        return category ? category.name : '未知分类';
    }
}

// 创建全局实例
window.siteConfig = new SiteConfig();

// 页面加载后自动初始化
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM加载完成，开始初始化配置...');
    window.siteConfig.init();
});