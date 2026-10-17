/**
 * ColorPick 拾色助手 —— 官网交互脚本
 *
 * 包含：
 *   1. 顶部导航：滚动吸顶状态、当前区块高亮、移动端汉堡菜单
 *   2. 滚动进入视口时的淡入上移动画（IntersectionObserver）
 *   3. 安装步骤里 edge:// 地址的一键复制
 *
 * 纯原生 JS，无任何依赖，双击 index.html 即可运行。
 */
(() => {
  'use strict';

  /* ------------------------------ 元素引用 ------------------------------ */

  const header = document.getElementById('siteHeader');
  const nav = document.getElementById('siteNav');
  const navToggle = document.getElementById('navToggle');
  const navLinks = Array.from(document.querySelectorAll('[data-nav]'));
  const sections = navLinks
    .map((link) => {
      const id = link.dataset.nav;
      const section = document.getElementById(id);
      return section ? { id, section } : null;
    })
    .filter(Boolean);

  const prefersReducedMotion = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

  /* ------------------------------- 导航状态 ------------------------------ */

  let ticking = false;

  /** 根据滚动位置更新导航栏样式与当前区块高亮 */
  function updateOnScroll() {
    const scrollY = window.scrollY || window.pageYOffset;

    // 吸顶后的毛玻璃 + 阴影
    if (header) header.classList.toggle('is-scrolled', scrollY > 8);

    // 当前区块高亮
    if (sections.length) {
      const headerHeight = header ? header.getBoundingClientRect().height : 68;
      const threshold = scrollY + headerHeight + 120;
      let currentId = '';

      sections.forEach(({ id, section }) => {
        const top = section.getBoundingClientRect().top + scrollY;
        if (top <= threshold) currentId = id;
      });

      // 滚动到页面底部时，高亮最后一个「获取插件」
      if (window.innerHeight + scrollY >= document.documentElement.scrollHeight - 4) {
        currentId = sections[sections.length - 1].id;
      }

      navLinks.forEach((link) => {
        const isActive = link.dataset.nav === currentId;
        link.classList.toggle('is-active', isActive);
        if (isActive) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
      });
    }

    ticking = false;
  }

  function requestScrollUpdate() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(updateOnScroll);
  }

  /* ------------------------------ 移动端菜单 ----------------------------- */

  function isMenuOpen() {
    return nav ? nav.classList.contains('is-open') : false;
  }

  function setMenu(open) {
    if (!nav || !navToggle) return;
    nav.classList.toggle('is-open', open);
    navToggle.setAttribute('aria-expanded', String(open));
    navToggle.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
  }

  function closeMenu() {
    if (isMenuOpen()) setMenu(false);
  }

  if (navToggle) {
    navToggle.addEventListener('click', () => setMenu(!isMenuOpen()));

    // 点击导航链接后收起菜单
    navLinks.forEach((link) => link.addEventListener('click', closeMenu));

    // Esc 关闭
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeMenu();
    });

    // 点击菜单外部关闭
    document.addEventListener('click', (event) => {
      if (!isMenuOpen()) return;
      if (nav && nav.contains(event.target)) return;
      if (navToggle.contains(event.target)) return;
      closeMenu();
    });

    // 窗口变宽时收起
    window.addEventListener('resize', () => {
      if (window.innerWidth > 860) closeMenu();
      requestScrollUpdate();
    });
  }

  /* ---------------------------- 进入视口动画 ---------------------------- */

  function initReveal() {
    const items = Array.from(document.querySelectorAll('.reveal'));
    if (!items.length) return;

    // 不支持 IntersectionObserver 或用户偏好减少动态效果时，直接显示
    if (!('IntersectionObserver' in window) || prefersReducedMotion) {
      items.forEach((item) => item.classList.add('is-visible'));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -6% 0px' }
    );

    items.forEach((item) => observer.observe(item));
  }

  /* -------------------------------- 复制 -------------------------------- */

  /** 复制文本，失败时降级到 execCommand */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.top = '-1000px';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand('copy');
        textarea.remove();
        return ok;
      } catch (e) {
        return false;
      }
    }
  }

  function initCopyButtons() {
    const buttons = Array.from(document.querySelectorAll('[data-copy]'));
    buttons.forEach((btn) => {
      const original = btn.textContent;
      btn.addEventListener('click', async () => {
        const value = btn.getAttribute('data-copy') || '';
        const ok = await copyText(value);
        btn.textContent = ok ? '已复制' : '复制失败';
        setTimeout(() => {
          btn.textContent = original;
        }, 1600);
      });
    });
  }

  /* -------------------------------- 启动 -------------------------------- */

  initReveal();
  initCopyButtons();
  updateOnScroll();

  window.addEventListener('scroll', requestScrollUpdate, { passive: true });
})();
