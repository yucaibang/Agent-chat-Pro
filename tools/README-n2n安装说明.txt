════════════════════════════════════════════════════════
 n2n Windows 客户端安装说明（配合 Agent Chat Pro v3.12.3+）
 生成：2026-09-24 · NAS 99 · Agent Chat Pro 项目工具目录
════════════════════════════════════════════════════════

【本目录文件】
1. tap-windows-9.21.2.exe        → TAP 虚拟网卡驱动（OpenVPN 官方构建）
2. n2n_v3_windows_x64_v3.1.1_r1255_static_by_heiye.zip
   → n2n v3.1.1 r1255 静态编译（与 NAS supernode 版本完全一致）
   → 解压后关键文件：edge.exe（客户端主程序）

【安装步骤（外网本机，需管理员）】
1. 双击 tap-windows-9.21.2.exe 安装 TAP 驱动
   - 全程下一步；Win10/11 可能弹驱动签名确认，选「仍要安装」
   - 装完在「网络连接」里会多出一个 TAP-Windows Adapter 适配器（正常）
2. 解压 n2n zip，把解压出的目录放到固定位置，例如：
   C:\n2n\   （保证里面有 edge.exe）
3. 把 C:\n2n 加入系统 PATH：
   Win+R → sysdm.cpl → 高级 → 环境变量 → Path → 新建 → C:\n2n → 确定
4. 开个新 cmd 验证：
   edge --version
   → 应显示 v3.1.1-71-g9618512... r1255 字样（与 NAS supernode 同版本）

【Agent Chat Pro 连接参数】
外网方案：N2N 虚拟局域网
  超级节点地址：entry.example.org
  超级节点端口：53371
  社区名：demo-community
  加密密钥：留空
  访问密码：自设并记住
SSH 目标：
  主机：10.0.0.1   端口：22
  用户名：demo-user   密码：NAS 的 SSH 密码

【传输模式说明】
v3.12.3 已内置自动兼容：
  第 1 次连接先试 UDP（约 10 秒，FRP TCP 隧道下会失败，正常）
  → 自动降级 TCP 模式（edge 加 -S2）→ 连接成功
  成功模式按入口缓存，第 2 次起直接 TCP。
无需手动加任何参数。

【常见故障】
- 「未找到 n2n edge 命令」→ PATH 没配好，或没用新开的 cmd 验证
- edge 启动后报 TAP 错误 → TAP 驱动没装/没以管理员安装
- 网络就绪超时（两种模式都失败）→ 检查 supernode 地址端口
  是否 entry.example.org:0；NAS 端 supernode 是否在跑
  （99 上：docker ps | grep n2n 两个容器应 healthy）
- 连上 N2N 但 SSH 失败 → NAS 端 sshd 必须监听 0.0.0.0:22（默认就是）
════════════════════════════════════════════════════════