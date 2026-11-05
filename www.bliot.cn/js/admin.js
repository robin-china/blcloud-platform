// 系统管理功能
class AdminManager {
    constructor() {
        this.config = null;
        this.currentConfig = null;
        this.editingProductId = null;
        this.init();
    }
    
    async init() {
        try {
            // 等待配置加载
            console.log('等待配置初始化...');
            await window.siteConfig.waitForInit();
            
            // 调试：打印配置信息
            console.log('原始配置:', window.siteConfig.config);
            console.log('原始公司信息:', window.siteConfig.config?.company);
            
            this.config = window.siteConfig.config;
            this.currentConfig = JSON.parse(JSON.stringify(this.config)); // 深拷贝
            
            // 验证配置结构
            this.validateConfig();
            
            // 调试：打印深拷贝后的配置
            console.log('深拷贝配置:', this.currentConfig);
            console.log('深拷贝公司信息:', this.currentConfig?.company);
            
            // 初始化界面
            this.initTabs();
            this.initCompanyForm();
            this.initProductTable();
            this.initJsonEditor();
            this.initEventListeners();
            this.initModal();
            
            // 尝试从本地存储加载（如果有保存的修改）
            this.loadFromLocal();
            
            // 显示上次保存时间
            this.updateLastSavedTime();
            
            console.log('AdminManager 初始化完成');
        } catch (error) {
            console.error('AdminManager 初始化失败:', error);
            // 显示错误信息
            this.showStatus('管理后台初始化失败: ' + error.message, 'error');
        }
    }
    
    // 验证配置结构
    validateConfig() {
        // 确保配置有正确的结构
        if (!this.currentConfig) {
            console.warn('配置为空，创建默认配置结构');
            this.currentConfig = {
                company: {
                    name: "",
                    brand: "",
                    address: "",
                    phone: "",
                    servicePhone: "",
                    email: "",
                    workHours: "",
                    copyright: "",
                    beian: ""
                },
                products: {
                    categories: [],
                    items: []
                }
            };
        }
        
        if (!this.currentConfig.company) {
            console.warn('公司配置不存在，创建默认公司配置');
            this.currentConfig.company = {
                name: "",
                brand: "",
                address: "",
                phone: "",
                servicePhone: "",
                email: "",
                workHours: "",
                copyright: "",
                beian: ""
            };
        }
        
        if (!this.currentConfig.products) {
            console.warn('产品配置不存在，创建默认产品配置');
            this.currentConfig.products = {
                categories: [],
                items: []
            };
        }
        
        console.log('配置验证完成:', this.currentConfig);
    }
    
    // 初始化标签页
    initTabs() {
        const tabs = document.querySelectorAll('.admin-tab');
        const panels = document.querySelectorAll('.admin-panel');
        
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const tabId = tab.getAttribute('data-tab');
                
                // 更新活动标签
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                
                // 显示对应面板
                panels.forEach(panel => {
                    panel.classList.remove('active');
                    if (panel.id === tabId) {
                        panel.classList.add('active');
                    }
                });
                
                // 更新导航链接状态
                this.updateNavLinks(tabId);
            });
        });
    }
    
    // 更新导航链接状态
    updateNavLinks(activeTab) {
        const navLinks = document.querySelectorAll('.nav-list .nav-link');
        navLinks.forEach(link => {
            link.classList.remove('active');
            if (link.getAttribute('href') === `#${activeTab}`) {
                link.classList.add('active');
            }
        });
    }
    
    // 初始化公司信息表单
    initCompanyForm() {
        console.log('初始化公司表单，当前配置:', this.currentConfig);
        
        if (!this.currentConfig || !this.currentConfig.company) {
            console.error('公司配置不存在!');
            this.showStatus('公司配置数据不存在', 'error');
            return;
        }
        
        const company = this.currentConfig.company;
        
        // 逐一设置表单值
        const setValue = (id, value) => {
            const element = document.getElementById(id);
            if (element) {
                element.value = value || '';
                console.log(`设置 ${id} = ${value}`);
            } else {
                console.warn(`元素 ${id} 不存在`);
            }
        };
        
        setValue('companyName', company.name);
        setValue('companyBrand', company.brand);
        setValue('companyAddress', company.address);
        setValue('companyPhone', company.phone);
        setValue('companyServicePhone', company.servicePhone);
        setValue('companyEmail', company.email);
        setValue('companyWorkHours', company.workHours);
        setValue('companyCopyright', company.copyright);
        setValue('companyBeian', company.beian);
        
        console.log('公司表单初始化完成');
    }
    
    // 初始化产品表格
    initProductTable() {
        this.renderProductTable();
    }
    
    // 渲染产品表格
    renderProductTable() {
        const tbody = document.getElementById('productsTableBody');
        const products = this.currentConfig.products.items || [];
        const categories = this.currentConfig.products.categories || [];
        
        if (products.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align: center; padding: 50px;">
                        <i class="fas fa-box-open fa-2x" style="color: #ccc; margin-bottom: 15px;"></i>
                        <p style="color: #666;">暂无产品数据</p>
                        <button class="btn btn-primary" id="addFirstProduct" style="margin-top: 15px;">
                            <i class="fas fa-plus"></i> 添加第一个产品
                        </button>
                    </td>
                </tr>
            `;
            
            // 添加点击事件
            document.getElementById('addFirstProduct')?.addEventListener('click', () => {
                this.openProductModal();
            });
            
            return;
        }
        
        let html = '';
        
        products.forEach(product => {
            // 获取分类名称
            const category = categories.find(cat => cat.id === product.category);
            const categoryName = category ? category.name : '未知分类';
            
            html += `
                <tr data-product-id="${product.id}">
                    <td>${product.id}</td>
                    <td class="product-image-cell">
                        <img src="${product.image}" alt="${product.name}" 
                             class="product-image-preview"
                             onerror="this.src='images/noimage.jpg'">
                    </td>
                    <td>
                        <strong>${product.name}</strong>
                        <div style="font-size: 0.9em; color: #666; margin-top: 5px;">
                            ${product.description.substring(0, 60)}...
                        </div>
                    </td>
                    <td>
                        <span class="product-category-badge" style="font-size: 0.8em;">${categoryName}</span>
                    </td>
                    <td>${product.price}</td>
                    <td>
                        <span style="color: #28a745; font-weight: 600;">
                            <i class="fas fa-check-circle"></i> 已发布
                        </span>
                    </td>
                    <td>
                        <div class="product-actions">
                            <button class="action-btn edit" data-action="edit" data-id="${product.id}">
                                <i class="fas fa-edit"></i> 编辑
                            </button>
                            <button class="action-btn delete" data-action="delete" data-id="${product.id}">
                                <i class="fas fa-trash"></i> 删除
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        });
        
        tbody.innerHTML = html;
        
        // 添加事件监听
        tbody.querySelectorAll('[data-action="edit"]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const productId = parseInt(e.currentTarget.getAttribute('data-id'));
                this.editProduct(productId);
            });
        });
        
        tbody.querySelectorAll('[data-action="delete"]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const productId = parseInt(e.currentTarget.getAttribute('data-id'));
                this.deleteProduct(productId);
            });
        });
    }
    
    // 初始化JSON编辑器
    initJsonEditor() {
        const editor = document.getElementById('jsonEditor');
        editor.value = JSON.stringify(this.currentConfig, null, 2);
        
        // 监听输入变化
        editor.addEventListener('input', () => {
            try {
                const parsed = JSON.parse(editor.value);
                editor.style.borderColor = '#28a745';
            } catch (error) {
                editor.style.borderColor = '#dc3545';
            }
        });
    }
    
    // 初始化事件监听
    initEventListeners() {
        // 公司信息保存
        document.getElementById('saveCompanyInfo')?.addEventListener('click', () => {
            this.saveCompanyInfo();
        });
        
        // 公司信息重置
        document.getElementById('resetCompanyForm')?.addEventListener('click', () => {
            this.initCompanyForm();
            this.showStatus('表单已重置', 'warning');
        });
        
        // 产品管理
        document.getElementById('refreshProducts')?.addEventListener('click', () => {
            this.renderProductTable();
            this.showStatus('产品列表已刷新', 'success');
        });
        
        document.getElementById('addProduct')?.addEventListener('click', () => {
            this.openProductModal();
        });
        
        // JSON编辑器
        document.getElementById('loadJson')?.addEventListener('click', () => {
            this.loadJsonFromServer();
        });
        
        document.getElementById('saveJson')?.addEventListener('click', () => {
            this.saveJsonToEditor();
        });
        
        document.getElementById('formatJson')?.addEventListener('click', () => {
            this.formatJson();
        });
        
        document.getElementById('validateJson')?.addEventListener('click', () => {
            this.validateJson();
        });
        
        document.getElementById('backupJson')?.addEventListener('click', () => {
            this.backupConfig();
        });
    }
    
    // 初始化模态框
    initModal() {
        const modal = document.getElementById('productModal');
        const closeBtn = document.getElementById('modalClose');
        const cancelBtn = document.getElementById('cancelProduct');
        
        // 关闭模态框
        [closeBtn, cancelBtn].forEach(btn => {
            btn?.addEventListener('click', () => {
                this.closeModal();
            });
        });
        
        // 点击模态框外部关闭
        modal?.addEventListener('click', (e) => {
            if (e.target === modal) {
                this.closeModal();
            }
        });
        
        // 图片预览
        document.getElementById('productImage')?.addEventListener('input', (e) => {
            this.updateImagePreview(e.target.value);
        });
        
        // 添加规格按钮
        document.getElementById('addSpec')?.addEventListener('click', () => {
            this.addSpecRow();
        });
        
        // 保存产品
        document.getElementById('saveProduct')?.addEventListener('click', () => {
            this.saveProduct();
        });
    }
    
    // 打开产品模态框
    openProductModal(product = null) {
        const modal = document.getElementById('productModal');
        const title = document.getElementById('modalTitle');
        const form = document.getElementById('productForm');
        
        // 重置表单
        form?.reset();
        
        // 清空规格
        const specsContainer = document.getElementById('specsContainer');
        if (specsContainer) {
            specsContainer.innerHTML = `
                <div class="spec-row" style="display: flex; gap: 10px; margin-bottom: 10px;">
                    <input type="text" class="form-control spec-key" placeholder="规格名称" style="flex: 1;">
                    <input type="text" class="form-control spec-value" placeholder="规格值" style="flex: 2;">
                    <button type="button" class="btn btn-outline remove-spec" style="padding: 8px 15px;">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            `;
        }
        
        if (product) {
            // 编辑模式
            title.textContent = '编辑产品';
            this.editingProductId = product.id;
            
            document.getElementById('productId').value = product.id;
            document.getElementById('productName').value = product.name;
            document.getElementById('productCategory').value = product.category;
            document.getElementById('productPrice').value = product.price;
            document.getElementById('productDescription').value = product.description;
            document.getElementById('productImage').value = product.image;
            
            // 产品特性
            if (product.features && product.features.length > 0) {
                document.getElementById('productFeatures').value = product.features.join('\n');
            }
            
            // 产品规格
            if (product.specs) {
                specsContainer.innerHTML = '';
                Object.entries(product.specs).forEach(([key, value]) => {
                    this.addSpecRow(key, value);
                });
            }
            
            // 图片预览
            this.updateImagePreview(product.image);
        } else {
            // 添加模式
            title.textContent = '添加新产品';
            this.editingProductId = null;
            
            // 生成新ID
            const products = this.currentConfig.products.items;
            const newId = products.length > 0 ? Math.max(...products.map(p => p.id)) + 1 : 1;
            document.getElementById('productId').value = newId;
            
            // 重置图片预览
            document.getElementById('previewImage').style.display = 'none';
            document.getElementById('noPreview').style.display = 'flex';
        }
        
        // 添加规格行的事件监听
        this.bindSpecEvents();
        
        // 显示模态框
        modal?.classList.add('active');
    }
    
    // 关闭模态框
    closeModal() {
        const modal = document.getElementById('productModal');
        modal?.classList.remove('active');
        this.editingProductId = null;
    }
    
    // 更新图片预览
    updateImagePreview(imageUrl) {
        const preview = document.getElementById('previewImage');
        const noPreview = document.getElementById('noPreview');
        
        if (preview && noPreview) {
            if (imageUrl) {
                preview.src = imageUrl;
                preview.style.display = 'block';
                noPreview.style.display = 'none';
            } else {
                preview.style.display = 'none';
                noPreview.style.display = 'flex';
            }
        }
    }
    
    // 添加规格行
    addSpecRow(key = '', value = '') {
        const container = document.getElementById('specsContainer');
        if (!container) return;
        
        const row = document.createElement('div');
        row.className = 'spec-row';
        row.style.cssText = 'display: flex; gap: 10px; margin-bottom: 10px;';
        
        row.innerHTML = `
            <input type="text" class="form-control spec-key" placeholder="规格名称" 
                   style="flex: 1;" value="${key}">
            <input type="text" class="form-control spec-value" placeholder="规格值" 
                   style="flex: 2;" value="${value}">
            <button type="button" class="btn btn-outline remove-spec" style="padding: 8px 15px;">
                <i class="fas fa-times"></i>
            </button>
        `;
        
        container.appendChild(row);
        this.bindSpecEvents();
    }
    
    // 绑定规格事件
    bindSpecEvents() {
        const removeButtons = document.querySelectorAll('.remove-spec');
        removeButtons.forEach(btn => {
            btn.addEventListener('click', function() {
                this.closest('.spec-row').remove();
            });
        });
    }
    
    // 编辑产品
    editProduct(productId) {
        const products = this.currentConfig.products.items;
        const product = products.find(p => p.id === productId);
        
        if (product) {
            this.openProductModal(product);
        }
    }
    
    // 删除产品
    deleteProduct(productId) {
        if (!confirm('确定要删除这个产品吗？此操作不可撤销。')) {
            return;
        }
        
        const products = this.currentConfig.products.items;
        const index = products.findIndex(p => p.id === productId);
        
        if (index !== -1) {
            products.splice(index, 1);
            this.renderProductTable();
            this.showStatus('产品删除成功', 'success');
            this.saveToLocal(); // 自动保存到本地
        }
    }
    
    // 保存产品
    saveProduct() {
        const form = document.getElementById('productForm');
        
        // 验证表单
        if (!form?.checkValidity()) {
            form?.reportValidity();
            return;
        }
        
        // 收集产品数据
        const productData = {
            id: parseInt(document.getElementById('productId').value),
            name: document.getElementById('productName').value,
            category: document.getElementById('productCategory').value,
            price: document.getElementById('productPrice').value,
            description: document.getElementById('productDescription').value,
            image: document.getElementById('productImage').value
        };
        
        // 产品特性
        const featuresText = document.getElementById('productFeatures').value;
        if (featuresText.trim()) {
            productData.features = featuresText.split('\n').filter(line => line.trim());
        }
        
        // 产品规格
        const specs = {};
        const specRows = document.querySelectorAll('.spec-row');
        specRows.forEach(row => {
            const key = row.querySelector('.spec-key')?.value?.trim();
            const value = row.querySelector('.spec-value')?.value?.trim();
            if (key && value) {
                specs[key] = value;
            }
        });
        
        if (Object.keys(specs).length > 0) {
            productData.specs = specs;
        }
        
        // 保存到配置
        const products = this.currentConfig.products.items;
        
        if (this.editingProductId !== null) {
            // 更新现有产品
            const index = products.findIndex(p => p.id === this.editingProductId);
            if (index !== -1) {
                products[index] = productData;
            }
        } else {
            // 添加新产品
            products.push(productData);
        }
        
        // 重新渲染表格
        this.renderProductTable();
        
        // 更新JSON编辑器
        this.updateJsonEditor();
        
        // 显示成功消息
        this.showStatus(`产品"${productData.name}"保存成功`, 'success');
        
        // 关闭模态框
        this.closeModal();
        
        // 自动保存到本地
        this.saveToLocal();
    }
    
    // 保存公司信息
    saveCompanyInfo() {
        // 确保 currentConfig 存在
        if (!this.currentConfig.company) {
            this.currentConfig.company = {};
        }
        
        const company = this.currentConfig.company;
        
        // 从表单获取值并保存
        company.name = document.getElementById('companyName').value || '';
        company.brand = document.getElementById('companyBrand').value || '';
        company.address = document.getElementById('companyAddress').value || '';
        company.phone = document.getElementById('companyPhone').value || '';
        company.servicePhone = document.getElementById('companyServicePhone').value || '';
        company.email = document.getElementById('companyEmail').value || '';
        company.workHours = document.getElementById('companyWorkHours').value || '';
        company.copyright = document.getElementById('companyCopyright').value || '';
        company.beian = document.getElementById('companyBeian').value || '';
        
        console.log('保存的公司信息:', company);
        
        // 更新JSON编辑器
        this.updateJsonEditor();
        
        // 显示成功消息
        this.showStatus('公司信息保存成功', 'success');
        
        // 自动保存到本地
        this.saveToLocal();
    }
    
    // 更新JSON编辑器
    updateJsonEditor() {
        const editor = document.getElementById('jsonEditor');
        if (editor) {
            editor.value = JSON.stringify(this.currentConfig, null, 2);
            editor.style.borderColor = '#28a745';
        }
    }
    
    // 从服务器加载JSON
    async loadJsonFromServer() {
        try {
            const response = await fetch('config/config.json');
            if (!response.ok) throw new Error('加载失败');
            
            const config = await response.json();
            this.currentConfig = config;
            
            // 验证配置结构
            this.validateConfig();
            
            // 更新JSON编辑器
            this.updateJsonEditor();
            
            // 更新公司信息表单
            this.initCompanyForm();
            
            // 更新产品表格
            this.renderProductTable();
            
            this.showStatus('配置已从服务器重新加载', 'success');
        } catch (error) {
            this.showStatus('加载失败: ' + error.message, 'error');
        }
    }
    
    // 保存JSON编辑器内容
    saveJsonToEditor() {
        try {
            const editor = document.getElementById('jsonEditor');
            const config = JSON.parse(editor.value);
            
            // 验证配置结构
            if (!config.company || !config.products) {
                throw new Error('配置文件格式不正确');
            }
            
            this.currentConfig = config;
            
            // 验证配置结构
            this.validateConfig();
            
            // 更新公司信息表单
            this.initCompanyForm();
            
            // 更新产品表格
            this.renderProductTable();
            
            this.showStatus('JSON配置保存成功', 'success');
            
            // 自动保存到本地
            this.saveToLocal();
        } catch (error) {
            this.showStatus('JSON格式错误: ' + error.message, 'error');
        }
    }
    
    // 格式化JSON
    formatJson() {
        try {
            const editor = document.getElementById('jsonEditor');
            const config = JSON.parse(editor.value);
            editor.value = JSON.stringify(config, null, 2);
            editor.style.borderColor = '#28a745';
            this.showStatus('JSON格式化完成', 'success');
        } catch (error) {
            this.showStatus('JSON格式错误: ' + error.message, 'error');
        }
    }
    
    // 验证JSON
    validateJson() {
        try {
            const editor = document.getElementById('jsonEditor');
            JSON.parse(editor.value);
            editor.style.borderColor = '#28a745';
            this.showStatus('JSON验证通过', 'success');
        } catch (error) {
            editor.style.borderColor = '#dc3545';
            this.showStatus('JSON验证失败: ' + error.message, 'error');
        }
    }
    
    // 备份配置
    backupConfig() {
        const configStr = JSON.stringify(this.currentConfig, null, 2);
        const blob = new Blob([configStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `config_backup_${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        this.showStatus('配置备份已下载', 'success');
    }
    
    // 保存到本地存储
    saveToLocal() {
        try {
            localStorage.setItem('site_config_backup', JSON.stringify(this.currentConfig));
            localStorage.setItem('site_config_last_save', new Date().toISOString());
            
            // 更新最后保存时间
            this.updateLastSavedTime();

            console.log('配置已保存到本地存储');
        } catch (error) {
            console.error('保存到本地存储失败:', error);
        }
    }
    
    // 从本地存储加载
    loadFromLocal() {
        try {
            const saved = localStorage.getItem('site_config_backup');
            const lastSave = localStorage.getItem('site_config_last_save');
            
            console.log('本地存储中有数据吗?', saved ? '是' : '否');
            
            if (saved && lastSave) {
                this.currentConfig = JSON.parse(saved);
                console.log('从本地存储加载的配置:', this.currentConfig);
                
                this.initCompanyForm();
                this.renderProductTable();
                this.updateJsonEditor();
                
                // 更新最后保存时间显示
                const timeElement = document.getElementById('lastSavedTime');
                if (timeElement) {
                    const date = new Date(lastSave);
                    timeElement.textContent = date.toLocaleString('zh-CN');
                }
                
                console.log('从本地存储加载配置成功');
            }
        } catch (error) {
            console.error('从本地存储加载失败:', error);
        }
    }
    
    // 更新最后保存时间
    updateLastSavedTime() {
        const lastSave = localStorage.getItem('site_config_last_save');
        const timeElement = document.getElementById('lastSavedTime');
        
        if (timeElement) {
            if (lastSave) {
                const date = new Date(lastSave);
                timeElement.textContent = date.toLocaleString('zh-CN');
            } else {
                timeElement.textContent = '从未保存';
            }
        }
    }
    
    // 显示状态消息
    showStatus(text, type = 'success') {
        const status = document.getElementById('statusMessage');
        const title = document.getElementById('statusTitle');
        const message = document.getElementById('statusText');
        const icon = status?.querySelector('.status-icon');
        
        if (!status || !title || !message || !icon) return;
        
        // 设置消息内容
        message.textContent = text;
        
        // 设置样式和图标
        status.className = 'status-message';
        
        switch (type) {
            case 'success':
                status.classList.add('success');
                title.textContent = '操作成功';
                icon.className = 'fas fa-check-circle status-icon';
                break;
            case 'error':
                status.classList.add('error');
                title.textContent = '操作失败';
                icon.className = 'fas fa-exclamation-circle status-icon';
                break;
            case 'warning':
                status.classList.add('warning');
                title.textContent = '提示';
                icon.className = 'fas fa-exclamation-triangle status-icon';
                break;
        }
        
        // 显示消息
        status.classList.add('show');
        
        // 3秒后自动隐藏
        setTimeout(() => {
            status.classList.remove('show');
        }, 3000);
    }
}

// 页面加载后初始化管理功能
document.addEventListener('DOMContentLoaded', async () => {
    console.log('开始初始化管理页面...');
    
    // 创建管理实例
    window.adminManager = new AdminManager();
});