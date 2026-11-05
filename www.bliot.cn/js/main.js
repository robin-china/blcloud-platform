// 通用功能 - 简化版
class App {
    constructor() {
        this.init();
    }
    
    init() {
        this.initMobileMenu();
        this.initContactForm();
        this.initCurrentYear();
    }
    
    // 初始化移动端菜单
    initMobileMenu() {
        const mobileMenuBtn = document.getElementById('mobileMenuBtn');
        const mainNav = document.querySelector('.main-nav');
        
        if (mobileMenuBtn && mainNav) {
            mobileMenuBtn.addEventListener('click', () => {
                mainNav.classList.toggle('active');
                const icon = mobileMenuBtn.querySelector('i');
                if (icon) {
                    icon.className = mainNav.classList.contains('active') 
                        ? 'fas fa-times' 
                        : 'fas fa-bars';
                }
            });
            
            // 点击菜单项后关闭菜单
            const navLinks = document.querySelectorAll('.nav-link');
            navLinks.forEach(link => {
                link.addEventListener('click', () => {
                    mainNav.classList.remove('active');
                    const icon = mobileMenuBtn.querySelector('i');
                    if (icon) {
                        icon.className = 'fas fa-bars';
                    }
                });
            });
        }
    }
    
    // 初始化联系表单
    initContactForm() {
        const contactForm = document.getElementById('contactForm');
        if (contactForm) {
            contactForm.addEventListener('submit', function(e) {
                e.preventDefault();
                
                // 简单的表单验证
                const inputs = this.querySelectorAll('input[required], textarea[required]');
                let isValid = true;
                
                inputs.forEach(input => {
                    if (!input.value.trim()) {
                        isValid = false;
                        input.style.borderColor = '#dc3545';
                    } else {
                        input.style.borderColor = '#eaeaea';
                    }
                });
                
                if (isValid) {
                    // 模拟提交成功
                    alert('感谢您的留言！我们会尽快与您联系。');
                    this.reset();
                } else {
                    alert('请填写所有必填字段。');
                }
            });
        }
    }
    
    // 设置当前年份
    initCurrentYear() {
        const yearElements = document.querySelectorAll('#currentYear');
        const currentYear = new Date().getFullYear();
        
        yearElements.forEach(element => {
            element.textContent = currentYear;
        });
    }
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    new App();
});