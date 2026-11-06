---
title: "第 12 章：原生服务"
description: "Android 的系统功能并非由单个单体进程交付。systemserver 托管基于 Java 的系统服务（ActivityManagerService、WindowManagerService、PackageManagerService 以及其他数十个服务）。平台的关键功能中有很大一部分运行在用 C++ 编写的..."
pubDate: 2026-11-03T16:47:15
---

# 第 12 章：原生服务

Android 的系统功能并非由单个单体进程交付。`system_server` 托管基于 Java 的系统服务（ActivityManagerService、WindowManagerService、PackageManagerService 以及其他数十个服务）。平台的关键功能中有很大一部分运行在用 C++ 编写的**独立原生进程**中。这些原生服务处理从屏幕上合成像素、路由触摸事件到在磁盘上安装 APK 的一切事务。

本章探索这些原生服务的架构与实现。它展示它们如何向 `servicemanager` 注册、通过 Binder 通信，以及如何与硬件（经由 HAL）和框架的其余部分交互。我们将走读实际 AOSP 源码，追踪贯穿完整流水线的数据流，并理解塑造每个服务的设计决策。

---

## 12.1 原生服务架构

### 12.1.1 什么是原生服务？

**原生服务**是一个满足以下条件的 C++ 进程：

1. 作为独立进程启动（由 `init` 从 `.rc` 文件启动）。
2. 向 `servicemanager` 注册一个或多个 Binder 接口。
3. 进入 Binder 线程池或事件循环来处理请求。
4. 在系统生命周期内持续运行（崩溃时由 `init` 重启）。

与全部栖身于 `system_server` JVM 内的 Java 系统服务不同，原生服务在自己的地址空间中运行。这提供了进程隔离——SurfaceFlinger 崩溃不会拖垮 AudioFlinger。它也让每个服务可以用所需的最小 Linux capabilities 和 SELinux 权限运行。

### 12.1.2 servicemanager 注册表模式

Android 服务发现机制的中心是 `servicemanager`，它是第一个也是最基础的原生服务。其他每个服务——无论原生还是 Java——都向它注册，每个客户端都通过它查找服务。

```mermaid
sequenceDiagram
    participant Init as init
    participant SM as servicemanager
    participant SF as SurfaceFlinger
    participant App as 应用

    Init->>SM: 启动（PID 1 fork）
    SM->>SM: becomeContextManager()
    SM->>SM: Looper::pollAll(-1)

    Init->>SF: 启动 SurfaceFlinger
    SF->>SM: addService("SurfaceFlinger", binder)
    SM->>SM: 存储在 mNameToService 映射中

    App->>SM: getService("SurfaceFlinger")
    SM->>SM: SELinux 访问检查
    SM-->>App: 返回 IBinder 句柄
    App->>SF: 直接 Binder 事务
```

该架构保证：

- **注册是经过认证的**：`servicemanager` 在允许 `addService()` 或 `getService()` 调用之前验证 SELinux 标签。
- **发现是集中的**：所有服务都可以通过一个众所周知的 Binder context 找到。
- **死亡被集中检测**：当服务死亡时，`servicemanager` 把它从注册表中移除，使后续查找失败。客户端通过自己链接到服务 binder 的 `IBinder::DeathRecipient` 检测死亡；注册回调（`IServiceCallback::onRegistration()`）只在服务（重新）注册时触发。

### 12.1.3 标准服务生命周期

每个原生服务都遵循一个共同模式。我们用 GPU 服务作为具体的最小示例来检验它。入口点在：

> `frameworks/native/services/gpuservice/main_gpuservice.cpp`

```cpp
int main(int /* argc */, char** /* argv */) {
    signal(SIGPIPE, SIG_IGN);

    // publish GpuService
    sp<GpuService> gpuservice = new GpuService();
    sp<IServiceManager> sm(defaultServiceManager());
    sm->addService(String16(GpuService::SERVICE_NAME), gpuservice, false);

    // limit the number of binder threads to 4.
    ProcessState::self()->setThreadPoolMaxThreadCount(4);

    // start the thread pool
    sp<ProcessState> ps(ProcessState::self());
    ps->startThreadPool();
    ps->giveThreadPoolName();
    IPCThreadState::self()->joinThreadPool();

    return 0;
}
```

此模式有五个步骤：

| 步骤 | 代码 | 用途 |
|------|------|---------|
| 1 | `signal(SIGPIPE, SIG_IGN)` | 防止损坏管道导致崩溃 |
| 2 | `new GpuService()` | 构造服务对象 |
| 3 | `sm->addService(...)` | 向 servicemanager 注册 |
| 4 | `setThreadPoolMaxThreadCount(N)` | 配置 Binder 线程池大小 |
| 5 | `joinThreadPool()` | 阻塞主线程处理 Binder 调用 |

一些服务使用略有不同的模式。`SensorService` 使用 `BinderService<T>` 模板，它把步骤 2-5 包装成一次调用：

> `frameworks/native/services/sensorservice/main_sensorservice.cpp`

```cpp
int main(int /*argc*/, char** /*argv*/) {
    signal(SIGPIPE, SIG_IGN);
    SensorService::publishAndJoinThreadPool();
    return 0;
}
```

`BinderService<T>::publishAndJoinThreadPool()` 模板调用 `T::getServiceName()` 确定注册名称，构造服务，调用 `addService()`，并进入线程池。

### 12.1.4 进程隔离与 init.rc 配置

每个原生服务都在 `init` 启动时解析的 `.rc` 文件中定义。典型定义看起来像：

```
service surfaceflinger /system/bin/surfaceflinger
    class core animation
    user system
    group graphics drmrpc readproc
    capabilities SYS_NICE
    onrestart restart --only-if-running zygote
    task_profiles HighPerformance
```

关键属性：

- **`class`**：确定服务在启动期间何时启动（例如 `core`、`main`、`late_start`）。
- **`user`/`group`**：用于进程隔离的 Linux UID/GID。
- **`capabilities`**：受限的 Linux capabilities 集合。
- **`onrestart`**：服务重启时要执行的动作（通常是依赖服务的级联重启）。
- **`task_profiles`**：用于 CPU 调度的 cgroup 配置。

### 12.1.5 三种 servicemanager

Android 实际上有三个 `servicemanager` 实例：

| 实例 | 二进制 | Binder 设备 | 用途 |
|----------|--------|---------------|---------|
| `servicemanager` | `/system/bin/servicemanager` | `/dev/binder` | Framework 服务 |
| `vndservicemanager` | `/vendor/bin/vndservicemanager` | `/dev/vndbinder` | Vendor HAL 服务 |
| `servicemanager`（recovery） | 用 `__ANDROID_RECOVERY__` 构建 | `/dev/binder` | 恢复模式 |

vendor 服务管理器存在的目的是强制执行 Treble 边界：vendor 进程不能直接访问 framework 服务，反之亦然。这种分离在内核层面通过不同的 Binder 设备节点强制执行。

### 12.1.6 Binder 线程池大小

每个原生服务根据其预期并发度精心配置 Binder 线程池大小。这个选择很重要：

- **线程太少**：客户端阻塞等待线程，延迟增加。
- **线程太多**：浪费内存和上下文切换开销。

以下是来自实际源码的线程池配置：

| 服务 | 最大线程数 | 理由 |
|---------|-------------|-----------|
| `servicemanager` | 0（基于 Looper） | 单线程以避免死锁 |
| `surfaceflinger` | 4 | VSYNC 驱动，并发有限 |
| `gpuservice` | 4 | 统计/查询的中等并发 |
| `media.codec` | 64 | 许多并行编解码器会话 |
| `installd` | 默认（约 15） | 多个并发的包操作 |
| `sensorservice` | 默认（约 15） | 许多并发的传感器客户端 |

servicemanager 中的 `setThreadPoolMaxThreadCount(0)` 调用值得特别注意。线程池中零线程意味着所有 Binder 处理都通过 Looper 在主线程上进行。这是刻意的：servicemanager 绝不能同步调用其他服务（那可能死锁）。所以它所有外发调用都是单向的，它顺序处理入站调用。

### 12.1.7 死亡通知与服务恢复

当原生服务崩溃时，恢复序列是：

```mermaid
sequenceDiagram
    participant Init as init
    participant SM as servicemanager
    participant Dead as 已崩溃的服务
    participant Clients as 客户端进程

    Dead->>Dead: 进程死亡（SIGKILL/SIGABRT）
    Note over Dead: 内核关闭所有文件描述符
    Dead->>SM: Binder 死亡通知（binderDied）
    SM->>SM: 从 mNameToService 移除
    Dead->>Clients: DeathRecipient::binderDied（每客户端链接）
    Init->>Init: 检测服务死亡（waitpid）
    Init->>Init: 执行 onrestart 触发器
    Init->>Dead: 重启服务进程
    Dead->>SM: addService()（重新注册）
    SM->>Clients: IServiceCallback::onRegistration(name, binder)
    Clients->>Dead: 重新获取服务句柄
```

注意 `servicemanager` 不会向客户端推送死亡通知——它的 `binderDied()` 只从 `mNameToService` 擦除已死服务（并丢弃该进程的回调）。每个客户端通过自己直接链接到服务 binder 的 `IBinder::DeathRecipient` 得知死亡。

`.rc` 文件中的 `onrestart` 指令触发级联重启。例如，当 SurfaceFlinger 崩溃时：

```
onrestart restart --only-if-running zygote
```

这会重启 `zygote` 进程（并由此重启所有应用进程），因为 SurfaceFlinger 状态不可恢复——所有 layer 句柄和缓冲区队列都已丢失。

### 12.1.8 权限与 capabilities

原生服务使用多层安全：

1. **Linux UID/GID**：由 `.rc` 文件中的 `user` 和 `group` 指令设置。例如，SurfaceFlinger 以 `user system` 运行，组包括 `graphics`、`drmrpc` 和 `readproc`。

2. **Linux Capabilities**：细粒度特权控制。例如，SurfaceFlinger 拥有 `SYS_NICE` capability 用于实时调度：
   ```
   capabilities SYS_NICE
   ```

3. **SELinux 强制访问控制**：每个 IPC 调用都对照 SELinux 策略检查。`service_contexts` 文件把服务名映射到 SELinux 类型：
   ```
   SurfaceFlinger  u:object_r:surfaceflinger_service:s0
   installd        u:object_r:installd_service:s0
   gpu             u:object_r:gpu_service:s0
   ```

4. **seccomp-bpf 沙箱**：媒体服务用它限制系统调用。`SetUpMinijail()` 函数应用一个 seccomp 过滤器，限制进程可以进行的 syscall，减小来自恶意媒体内容的攻击面。

### 12.1.9 原生服务地图

下图展示主要原生服务及其关系：

```mermaid
graph TB
    subgraph "原生服务（独立进程）"
        SM[servicemanager]
        SF[SurfaceFlinger]
        AF[AudioFlinger]
        CS[CameraService]
        MS[MediaCodecService]
        ID[installd]
        GPU[GpuService]
        SS[SensorService]
    end

    subgraph "HAL 层"
        HWC[HWComposer HAL]
        AudioHAL[Audio HAL]
        CameraHAL[Camera HAL]
        SensorHAL[Sensor HAL]
    end

    subgraph "Framework"
        WMS[WindowManagerService]
        IMS[InputManagerService]
        IF["InputFlinger<br/>（在 system_server 中）"]
        PMS[PackageManagerService]
        SysSrv[system_server]
    end

    SM --- SF
    SM --- IF
    SM --- AF
    SM --- CS
    SM --- MS
    SM --- ID
    SM --- GPU
    SM --- SS

    SF --> HWC
    AF --> AudioHAL
    CS --> CameraHAL
    SS --> SensorHAL

    WMS --> SF
    IMS -->|JNI，进程内| IF
    PMS --> ID
    SysSrv --> AF
    SysSrv --> CS
```

每条箭头代表一个 Binder 连接，只有一个例外：InputFlinger 不是独立进程，而是 `system_server` 内的一组原生线程。InputManagerService 通过 JNI 进程内调用而非 Binder 到达它（见 12.3）。原生服务位于上方 Java framework 与下方 HAL 实现之间，把高级 API 调用翻译成硬件操作。

---

## 12.2 SurfaceFlinger

SurfaceFlinger 是**显示合成服务**——可以说是 Android 中最复杂、性能最敏感的原生服务。它接收来自每个应用和系统 UI 组件的图形缓冲区，并把它们合成到一起。它在正确的时间把结果显示在显示屏上，与垂直同步（VSYNC）信号同步。

### 12.2.1 源码布局

`frameworks/native/services/surfaceflinger/` 的 SurfaceFlinger 源码树非常庞大——大约 650 个文件（排除测试和 fuzzer 约 340 个），组织成以下结构：

| 目录 | 用途 |
|-----------|---------|
| `CompositionEngine/` | 合成流水线的抽象 |
| `Display/` | 显示设备管理、模式切换 |
| `DisplayHardware/` | HWComposer HAL 接口、电源控制 |
| `Effects/` | 颜色校正（为色盲用户的 Daltonizer） |
| `FrameTracer/` | 逐帧性能追踪 |
| `FrontEnd/` | Layer 生命周期、快照构建、事务处理 |
| `Jank/` | Jank 检测与上报 |
| `PowerAdvisor/` | 向 Power HAL 的 ADPF 电源提示 |
| `Scheduler/` | VSYNC 预测、帧调度、刷新率选择 |
| `TimeStats/` | 帧时序统计 |
| `Tracing/` | 用于 layer 与事务追踪的 Perfetto 集成 |
| `Utils/` | 共享工具（fence、dumper） |

主实现在 `SurfaceFlinger.cpp`。`SurfaceFlinger.h` 的头文件揭示类层次：

> `frameworks/native/services/surfaceflinger/SurfaceFlinger.h`

```cpp
class SurfaceFlinger : public BnSurfaceComposer,
                       public PriorityDumper,
                       private IBinder::DeathRecipient,
                       private HWC2::ComposerCallback,
                       private ICompositor,
                       private scheduler::ISchedulerCallback,
                       private compositionengine::ICEPowerCallback {
```

SurfaceFlinger 继承自：

- **`BnSurfaceComposer`**：遗留手写 C++ `ISurfaceComposer` 接口的 Binder 原生侧（`frameworks/native/libs/gui/include/gui/ISurfaceComposer.h`），仍用于热路径如 `setTransactionState()` 和缓冲区注册。AIDL 接口 `android.gui.ISurfaceComposer` 由单独的 `SurfaceComposerAIDL` 类（在 `SurfaceFlinger.h` 末尾附近声明）服务，它把调用转发给 SurfaceFlinger。
- **`PriorityDumper`**：支持 `dumpsys SurfaceFlinger` 的基于优先级的转储分段。
- **`HWC2::ComposerCallback`**：接收来自 Hardware Composer HAL 的回调（hotplug、VSYNC、刷新率变化）。
- **`ICompositor`**：Scheduler 用于触发合成的接口。
- **`ISchedulerCallback`**：接收调度决策（模式变化、帧率更新）。

### 12.2.2 高层架构

```mermaid
graph TB
    subgraph "应用"
        App1["App 1<br/>BufferQueue 生产者"]
        App2["App 2<br/>BufferQueue 生产者"]
        SysUI["SystemUI<br/>BufferQueue 生产者"]
    end

    subgraph "SurfaceFlinger 进程"
        direction TB
        FE["FrontEnd<br/>Layer 管理"]
        TX[事务处理器]
        SCH["Scheduler<br/>VSYNC + 帧时序"]
        CE[CompositionEngine]
        RE["RenderEngine<br/>GPU 合成"]
    end

    subgraph "硬件"
        HWC[HWComposer HAL]
        DISP[显示面板]
    end

    App1 -->|BufferQueue| FE
    App2 -->|BufferQueue| FE
    SysUI -->|BufferQueue| FE
    TX --> FE
    SCH -->|VSYNC 回调| CE
    FE --> CE
    CE -->|Overlay layer| HWC
    CE -->|Client layer| RE
    RE -->|Framebuffer| HWC
    HWC --> DISP
```

### 12.2.3 合成周期

SurfaceFlinger 的主循环由 Scheduler 驱动。在每个 VSYNC 周期，执行以下步骤：

1. **Commit 阶段**（`commit()`）：
   - 应用挂起的事务（layer 创建、属性变化、缓冲区更新）。
   - 从前端状态构建 layer 快照。
   - 更新 layer 树层次。

2. **合成阶段**（`composite()`）：
   - 对每个显示，确定可见 layer 集合。
   - 把 layer 发送给 HWComposer 进行 `validateDisplay()`。
   - HWC 决定哪些 layer 可以在硬件中合成（overlay），哪些需要 GPU 回退（client composition）。
   - 如果需要 client composition，用 RenderEngine（Skia/OpenGL）把这些 layer 渲染到 framebuffer。
   - 调用 `presentDisplay()` 把最终帧提交给显示。

3. **合成后**：
   - 向应用发出释放 fence，让它们可以复用缓冲区。
   - 更新帧时序统计。
   - 如果错过帧，发送 jank 指标。

关键性能洞察是 HWC overlay 合成本质上是"免费"的——显示硬件以零 GPU 成本合成 layer。GPU 合成是 HWC 无法处理（例如复杂混合模式、layer 过多、色彩空间转换）的 layer 的回退方案。

### 12.2.4 Layer 管理

**Layer** 表示矩形区域的图形内容。每个 layer 有：

- **通过事务交付的缓冲区**：自 BLAST 改造以来，客户端用 `Transaction::setBuffer()` 附加每个图形缓冲区。layer 把它存储在绘制状态（`mDrawingState.buffer`）中。生产者/消费者 `BufferQueue` 对位于应用的 `BLASTBufferQueue` 中，不在 SurfaceFlinger 内部。
- 单个**绘制状态**（`mDrawingState`）；挂起的客户端状态作为 `RequestedLayerState` 保存在 FrontEnd 中，它为合成构建不可变的 `LayerSnapshot`。
- 几何属性：位置、大小、裁剪、变换、z 序。
- 视觉属性：alpha、颜色、混合模式、色彩空间。

来自 `frameworks/native/services/surfaceflinger/Layer.cpp`：

```cpp
Layer::Layer(const surfaceflinger::LayerCreationArgs& args)
      : sequence(args.sequence),
        mFlinger(sp<SurfaceFlinger>::fromExisting(args.flinger)),
        mName(base::StringPrintf("%s#%d", args.name.c_str(), sequence)),
        mWindowType(static_cast<WindowInfo::Type>(
                args.metadata.getInt32(gui::METADATA_WINDOW_TYPE, 0))) {
    ALOGV("Creating Layer %s", getDebugName());

    mDrawingState.crop = {0, 0, -1, -1};
    mDrawingState.sequence = 0;
    mDrawingState.transform.set(0, 0);
    mDrawingState.frameNumber = 0;
    // ...
}
```

`FrontEnd/` 子系统通过以下方式管理 layer 生命周期：

- **`LayerLifecycleManager`**：跟踪创建和销毁。
- **`LayerSnapshotBuilder`**：为合成引擎产生不可变快照，避免事务线程与合成线程之间的锁竞争。
- **`TransactionHandler`**：原子地排队和应用事务。

SurfaceFlinger 强制最多 4096 个 layer（`MAX_LAYERS = 4096`）以防止资源耗尽。

### 12.2.5 Scheduler 与 VSYNC

位于 `frameworks/native/services/surfaceflinger/Scheduler/` 的 Scheduler 子系统负责：

- **VSYNC 预测**：用 `VSyncPredictor` 基于历史数据估计未来 VSYNC 时间戳。
- **刷新率选择**：基于活跃 layer 帧率选择最优显示刷新率（60Hz、90Hz、120Hz 等）。
- **帧调度**：在 VSYNC 之前合适的时间唤醒 SurfaceFlinger 执行合成。

```mermaid
sequenceDiagram
    participant HWC as HWComposer
    participant VS as VsyncSchedule
    participant SCH as Scheduler
    participant SF as SurfaceFlinger
    participant ET as EventThread

    HWC->>VS: 硬件 VSYNC 信号
    VS->>VS: VSyncPredictor 更新模型
    SCH->>SCH: 计算下一次唤醒
    SCH->>SF: ICompositor::commit()
    SF->>SF: 应用事务
    SF->>SF: 构建 layer 快照
    SCH->>SF: ICompositor::composite()
    SF->>HWC: validateDisplay() + presentDisplay()
    SCH->>ET: 向应用分发 VSYNC
    ET->>ET: 应用接收 Choreographer 回调
```

关键类：

- **`Scheduler`**（`Scheduler.h`）：协调所有时序。同时继承 `IEventThreadCallback` 和 `MessageQueue`。
- **`VSyncPredictor`**（`VSyncPredictor.cpp`）：对硬件 VSYNC 时间戳拟合线性模型以预测未来事件。
- **`VSyncDispatchTimerQueue`**（`VSyncDispatchTimerQueue.cpp`）：管理不同 VSYNC 客户端的基于定时器的唤醒。
- **`RefreshRateSelector`**（`RefreshRateSelector.cpp`）：选择最能满足所有活跃 layer 的显示模式（刷新率 + 分辨率）。
- **`EventThread`**（`EventThread.cpp`）：向应用交付 VSYNC 事件
  via `DisplayEventConnection`.

### 12.2.6 HWComposer HAL 关系

SurfaceFlinger 通过 HWComposer HAL（Hardware Composer）与显示硬件通信。该接口定义为位于以下位置的 AIDL HAL：

```
hardware/interfaces/graphics/composer/aidl/
```

`HWComposer` 包装类（`DisplayHardware/HWComposer.h`）把 SurfaceFlinger 的内部表示翻译成 HAL 调用：

```mermaid
graph LR
    SF[SurfaceFlinger] --> HWC[HWComposer 包装]
    HWC --> HAL[IComposer HAL]
    HAL --> DRM[DRM/KMS 驱动]
    DRM --> Panel[显示面板]
```

关键 HAL 操作是：

| HAL 方法 | 用途 |
|-----------|---------|
| `createLayer()` | 为显示创建 HWC layer 句柄（overlay 平面的分配稍后在 `validateDisplay()` 时决定） |
| `setLayerBuffer()` | 把图形缓冲区分配给 layer |
| `setLayerCompositionType()` | 标记为 DEVICE（overlay）或 CLIENT（GPU） |
| `validateDisplay()` | 让 HWC 评估 layer 栈 |
| `acceptDisplayChanges()` | 接受 HWC 的合成类型决策 |
| `presentDisplay()` | 提交帧用于显示 |
| `getReleaseFences()` | 获取用于缓冲区回收的 fence |

### 12.2.7 CompositionEngine

`CompositionEngine`（位于 `CompositionEngine/`）是把合成算法与 SurfaceFlinger 策略逻辑解耦的抽象。它处理一组 `CompositionRefreshArgs`，并为每个显示产生合成帧。

引擎内的合成流程：

```mermaid
graph TB
    subgraph "CompositionEngine::present()"
        A["1. 收集每个显示输出<br/>的可见 layer"]
        B["2. 计算几何<br/>裁剪、变换、z 序"]
        C["3. validateDisplay<br/>发送给 HWC"]
        D{"HWC 决定<br/>合成类型"}
        E["4a. DEVICE layer：<br/>硬件 overlay"]
        F["4b. CLIENT layer：<br/>GPU 合成"]
        G["5. RenderEngine::drawLayers<br/>GPU 上的 Skia"]
        H["6. presentDisplay<br/>提交给显示"]
        I["7. 释放 fence<br/>回到生产者"]
    end

    A --> B
    B --> C
    C --> D
    D -->|可 overlay| E
    D -->|需要 GPU 回退| F
    F --> G
    E --> H
    G --> H
    H --> I
```

合成引擎中的每个 `Output` 代表一个显示或虚拟显示。引擎的 `OutputLayer` 对象用显示特定的合成状态（例如 HWC 在该显示上分配给该 layer 的合成类型）包装单个 layer 快照。

**预测性合成策略**

一个现代优化是预测性合成，由以下标志控制：

```cpp
// If set, composition engine tries to predict the composition strategy
// provided by HWC based on the previous frame. If the strategy can be
// predicted, gpu composition will run parallel to the hwc validateDisplay
// call and re-run if the prediction is incorrect.
bool mPredictCompositionStrategy = false;
```

启用后，合成引擎基于上一帧的 HWC 决策预测哪些 layer 需要 GPU 回退。它在 `validateDisplay()` 调用并行开始 GPU 合成。如果预测正确，GPU 工作在 `validateDisplay()` 返回时已经完成，为 GPU 合成路径省下整帧延迟。

### 12.2.8 RenderEngine：GPU 合成

当 HWC 无法合成所有 layer（layer 过多、不支持的混合模式、需要色彩空间转换）时，SurfaceFlinger 用 RenderEngine 进行基于 GPU 的合成。RenderEngine 使用以下方式实现：

- **Skia**：主要渲染后端，使用 Vulkan 或 GLES。
- **线程化渲染**：RenderEngine 可以在专用线程上运行，避免阻塞主合成线程。

关键的 RenderEngine 操作是 `drawLayers()`。它接收一组 layer 设置（源缓冲区、几何、混合模式、颜色矩阵）并把它们合成到单个输出缓冲区。该缓冲区随后作为"client target" layer 传给 HWC。

### 12.2.9 事务模型

应用通过**事务**修改 layer 属性。事务是一组一起应用的原子变更：

```mermaid
sequenceDiagram
    participant App as 应用
    participant SC as SurfaceControl
    participant TX as Transaction
    participant SF as SurfaceFlinger
    participant FE as FrontEnd

    App->>TX: setPosition(layer, x, y)
    App->>TX: setAlpha(layer, 0.5)
    App->>TX: setBuffer(layer, buffer)
    App->>TX: apply()
    TX->>SF: setTransactionState(state, applyToken)
    SF->>SF: 排队事务
    Note over SF: 下一个 VSYNC...
    SF->>FE: 应用排队的事务
    FE->>FE: 更新 LayerLifecycleManager
    FE->>FE: 构建新快照
```

`TransactionHandler` 管理挂起事务的队列。事务可以是：

- **立即**：在下一个 VSYNC 应用。
- **延迟**：等到请求的 `setDesiredPresentTime()` 到达，或等到未触发的 acquire fence 和 apply-token 排序允许事务 latch。
- **同步**：跨不同 surface 原子地应用多个事务。

`LayerLifecycleManager` 尤其值得注意：

> `frameworks/native/services/surfaceflinger/FrontEnd/LayerLifecycleManager.h`

```cpp
// Owns a collection of RequestedLayerStates and manages their lifecycle
// and state changes.
//
// RequestedLayerStates are tracked and destroyed if they have no parent
// and no handle left to keep them alive.
class LayerLifecycleManager {
public:
    void addLayers(std::vector<std::unique_ptr<RequestedLayerState>>);
    void applyTransactions(const std::vector<QueuedTransactionState>&,
                           bool ignoreUnknownLayers = false);
    void onHandlesDestroyed(const std::vector<std::pair<uint32_t,
                            std::string>>&,
                            bool ignoreUnknownHandles = false);
    void fixRelativeZLoop(uint32_t relativeRootId);
    void commitChanges();
    // ...
};
```

### 12.2.10 HWComposer 回调

SurfaceFlinger 接收来自 HWComposer HAL 的几个回调：

```cpp
// HWC2::ComposerCallback overrides:
void onComposerHalVsync(hal::HWDisplayId, nsecs_t timestamp,
                        std::optional<hal::VsyncPeriodNanos>) override;
void onComposerHalHotplugEvent(hal::HWDisplayId,
                                DisplayHotplugEvent) override;
void onComposerHalRefresh(hal::HWDisplayId) override;
void onComposerHalVsyncPeriodTimingChanged(hal::HWDisplayId,
                        const hal::VsyncPeriodChangeTimeline&) override;
void onComposerHalSeamlessPossible(hal::HWDisplayId) override;
void onComposerHalVsyncIdle(hal::HWDisplayId) override;
void onRefreshRateChangedDebug(
                        const RefreshRateChangedDebugData&) override;
void onComposerHalHdcpLevelsChanged(hal::HWDisplayId,
                        const HdcpLevels& levels) override;
```

| 回调 | 触发 | SurfaceFlinger 响应 |
|----------|---------|------------------------|
| `onVsync` | 硬件 VSYNC 脉冲 | 更新 VSyncPredictor 模型 |
| `onHotplugEvent` | 显示连接/断开 | 创建/销毁 DisplayDevice |
| `onRefresh` | HWC 请求刷新 | 调度立即合成 |
| `onVsyncPeriodTimingChanged` | 刷新率变更进行中 | 更新时序参数 |
| `onVsyncIdle` | 显示已进入空闲（VRR） | 为空闲调整调度 |
| `onHdcpLevelsChanged` | HDCP 保护级别变化 | 更新内容保护状态 |

### 12.2.11 ISurfaceComposer API

SurfaceFlinger 通过 `ISurfaceComposer` AIDL 接口暴露丰富的 API。关键方法类别包括：

**显示管理**：

- `createVirtualDisplay()` / `destroyVirtualDisplay()`
- `getPhysicalDisplayIds()` / `getPhysicalDisplayToken()`
- `setDesiredDisplayModeSpecs()`（刷新率策略）
- `setPowerMode()`（ON、OFF、DOZE、DOZE_SUSPEND）
- `setDisplayBrightness()`

**Layer 操作**：

- `setTransactionState()`（所有 layer 变更的主要通道）。`Transaction::setFrameRate()` 帧率偏好等每 surface 属性在它内部传输。它们不是独立的接口方法。
- `setGameModeFrameRateOverride()`（游戏特定覆盖）

**屏幕捕获**：

- `captureDisplay()`（显示截图）
- `captureLayers()`（特定 layer 截图）

**监控**：

- `addFpsListener()` / `addHdrLayerInfoListener()`
- `addRegionSamplingListener()`（用于自动亮度的亮度采样）
- `addWindowInfosListener()`（供 InputFlinger 的窗口信息更新）

### 12.2.12 可变刷新率（VRR）支持

现代显示支持可变刷新率（VRR），其中显示的刷新周期可以动态变化。SurfaceFlinger 通过以下方式处理：

```mermaid
stateDiagram-v2
    [*] --> Active: 内容更新中
    Active --> Active: 帧在截止时间前提交
    Active --> Idle: 超时周期内无帧
    Idle --> Active: 提交新帧
    Idle --> Idle: 显示保持最后一帧

    note right of Active
        显示按内容帧率
        刷新
        （例如 60Hz、90Hz、120Hz）
    end note

    note right of Idle
        显示用面板自刷新
        保持帧
        节省显示功耗
    end note
```

`VsyncSchedule` 类管理 VRR 感知调度：

- 当内容活跃更新时，VSYNC 按内容的帧率运行。
- 当没有新内容到达时，显示进入空闲模式并调用 `onComposerHalVsyncIdle()`。
- Scheduler 自己的 VRR 空闲定时器通过 `ISchedulerCallback::vrrDisplayIdle()` 通知 SurfaceFlinger（`frameworks/native/services/surfaceflinger/Scheduler/ISchedulerCallback.h:35`，从 `Scheduler.cpp:176`/`180` 触发）。SurfaceFlinger 的覆盖（`SurfaceFlinger.cpp:8022`）通过 `onVrrIdle()` 把状态转发给显示的刷新率 overlay。不必要的唤醒在 Scheduler 自己的定时器内部被抑制，而不是在此回调中。
- `KernelIdleTimerController` 枚举（在 `RefreshRateSelector` 中）选择内核显示空闲定时器如何驱动——通过 sysprop（`Sysprop`）或 HWC API（`HwcApi`）。`RefreshRateSelector`/SurfaceFlinger 通过所选机制应用超时。

`VsyncModulator` 基于工作负载调整 VSYNC 偏移。它持有一个 `VsyncConfigSet`，包含三种可能配置并跟踪当前活跃的是哪一种：

```cpp
// Scheduler/include/scheduler/VsyncConfig.h
struct VsyncConfigSet {
    VsyncConfig early;    // Used for early transactions, and during refresh rate change.
    VsyncConfig earlyGpu; // Used during GPU composition.
    VsyncConfig late;     // Default.
    // ...
};

// Scheduler/VsyncModulator.h
class VsyncModulator {
    enum class VsyncConfigType { Early, EarlyGpu, Late };
    // ...
    VsyncConfigSet mVsyncConfigSet;
    VsyncConfig mVsyncConfig{mVsyncConfigSet.late};
    // ...
};
```

`early` 配置让 SurfaceFlinger 更早唤醒（例如触摸事件到达且预期新帧时，或刷新率变更期间）。`earlyGpu` 在帧回退到 GPU 合成时应用。`late` 是可预测工作负载的默认值。

### 12.2.13 Latch Unsignaled

`LatchUnsignaledConfig` 控制 SurfaceFlinger 是否可以在缓冲区的 acquire fence 触发之前 latch（使用）它：

```cpp
enum class LatchUnsignaledConfig {
    Disabled,           // Never latch unsignaled buffers
    AutoSingleLayer,    // Latch unsignaled only for single-layer
                        // buffer-only updates
    Always,             // Always latch unsignaled (risky)
};
```

`AutoSingleLayer` 模式是生产默认值。当单个 layer 提交缓冲区更新且没有其他挂起事务时，SurfaceFlinger 直接把缓冲区的 acquire fence 传给 HWC。如果 fence 在显示截止时间之前触发，帧被显示；否则，显示上一帧。这为简单缓冲区更新减少一帧延迟。

### 12.2.14 电源管理

SurfaceFlinger 通过以下方式与 Android 电源管理集成：

1. **PowerAdvisor**：与 `PowerHAL` 通信发送 ADPF（Android Dynamic Performance Framework）提示。合成前，SurfaceFlinger 报告预期工作负载持续时间；合成后，它报告实际持续时间。电源 HAL 用此信息调整 CPU/GPU 频率。

2. **显示电源模式**：SurfaceFlinger 控制显示电源状态：
   - `OFF`：显示关闭，SurfaceFlinger 停止合成。
   - `ON`：正常运行。
   - `DOZE`：环境显示（低功耗、低亮度）。
   - `DOZE_SUSPEND`：与 DOZE 类似但 SurfaceFlinger 停止合成（显示控制器显示静态图像）。

3. **CPU 负载通知**：`ICEPowerCallback::notifyCpuLoadUp()` 回调警告电源系统即将到来的 CPU 负载增加（例如一批事务正在处理中）。

### 12.2.15 显示亮度与色彩管理

SurfaceFlinger 管理显示的色彩流水线：

- **广色域**：支持 Display-P3 和 BT.2020 色彩空间。`defaultCompositionDataspace` 和 `wideColorGamutCompositionDataspace` 控制渲染色彩空间。

- **HDR**：管理 HDR 内容合成，包括 SDR 到 HDR 和 HDR 到 SDR 的色调映射。`HdrLayerInfoReporter` 在屏幕上有 HDR 内容时通知感兴趣的客户端。

- **颜色矩阵**：可以对整个显示输出应用 4x4 颜色变换矩阵，用于无障碍功能（颜色反转、为色盲用户的 daltonizer）。

- **区域采样**：`RegionSamplingThread` 从指定屏幕区域采样像素值。状态栏用它调整文本颜色，以在背景内容上保持可读性。

### 12.2.16 启动阶段

SurfaceFlinger 跟踪三个启动阶段：

```cpp
enum class BootStage {
    BOOTLOADER,     // Display showing bootloader splash
    BOOTANIMATION,  // Boot animation playing
    FINISHED,       // System fully booted
};
```

在 `BOOTLOADER` 阶段，SurfaceFlinger 初始化但还不会驱动显示。一旦 `BOOTANIMATION` 开始，SurfaceFlinger 开始合成启动动画帧。当 `system_server` 调用 `bootFinished()` 时，阶段转换到 `FINISHED`，正常运行开始。

### 12.2.17 交叉引用

SurfaceFlinger 与在其他章节覆盖的图形流水线深度交织：

- **第 13 章（图形渲染流水线）**：为 SurfaceFlinger 提供缓冲区的 BufferQueue 生产者-消费者模型。它还详细覆盖 CompositionEngine、RenderEngine（Skia）和逐帧合成算法。
- **第 10 章（HAL）**：HWComposer HAL 接口及其 AIDL 定义。

---

## 12.3 InputFlinger

InputFlinger 处理所有用户输入——触摸事件、按键、触控笔笔划、鼠标移动、手柄按钮——并把它们路由到正确的应用窗口。它是 Android 中对延迟最敏感的服务之一；即使多几毫秒延迟用户也能感知。

### 12.3.1 源码布局

InputFlinger 源码位于 `frameworks/native/services/inputflinger/`，组织为：

| 目录 | 用途 |
|-----------|---------|
| `reader/` | EventHub + InputReader：读取原始内核事件 |
| `dispatcher/` | InputDispatcher：把事件路由到窗口 |
| `reporter/` | InputReporter：上报未处理和丢弃按键（`InteractionReporter` 位于 inputflinger 根目录，不在这里） |
| `trace/` | Perfetto 追踪集成 |
| `rust/` | 通过 `IInputFlingerRust` 的 Rust FFI 组件 |
| `aidl/` | AIDL 接口定义 |
| 根文件 | InputManager、过滤器、拦截器、choreographer |

### 12.3.2 输入流水线

`InputManager.cpp` 中的注释描述完整流水线：

> `frameworks/native/services/inputflinger/InputManager.cpp`

```cpp
/**
 * The event flow is via the "InputListener" interface, as follows:
 *   InputReader
 *     -> UnwantedInteractionBlocker
 *     -> InputFilter
 *     -> PointerChoreographer
 *     -> InputProcessor
 *     -> InputDeviceMetricsCollector
 *     -> InteractionReporter
 *     -> InputDispatcher
 */
```

不过，此注释相对于紧接其下的代码已经过时。构造函数自底向上构建监听器链，每个阶段包装前一个构造的阶段。它把 `InputFilter` 放在 `InputDeviceMetricsCollector` 之后，而不是紧接 `UnwantedInteractionBlocker` 之后。实际产生的接线是：

```
InputReader
  -> UnwantedInteractionBlocker
  -> PointerChoreographer
  -> InputProcessor
  -> InputDeviceMetricsCollector
  -> InputFilter
  -> InteractionReporter
  -> InputDispatcher
```

`InteractionReporter` 阶段（在 `frameworks/native/services/inputflinger/InteractionReporter.cpp`，inputflinger 根目录）是分发器之前的倒数第二个监听器。它浮出交互信号——例如在用户交互时唤醒 attention service——而不干扰事件流。（`reporter/` 下同名的 `InputReporter` 是不同的、无关的类，只上报未处理和丢弃的按键。）

让我们从硬件到应用追踪这个流水线：

```mermaid
graph LR
    subgraph "内核"
        DEV["/dev/input/*"]
    end

    subgraph "InputFlinger 流水线"
        EH[EventHub]
        IR[InputReader]
        UIB["UnwantedInteraction<br/>Blocker"]
        PC[PointerChoreographer]
        IP[InputProcessor]
        MC[MetricsCollector]
        IF[InputFilter]
        REP[InteractionReporter]
        ID[InputDispatcher]
    end

    subgraph "应用"
        W1[窗口 1]
        W2[窗口 2]
    end

    DEV --> EH
    EH --> IR
    IR --> UIB
    UIB --> PC
    PC --> IP
    IP --> MC
    MC --> IF
    IF --> REP
    REP --> ID
    ID --> W1
    ID --> W2
```

### 12.3.3 EventHub：读取原始事件

EventHub 是输入栈的最底层。它：

1. 用 `inotify` 监控 `/dev/input/` 的设备热插拔事件。
2. 打开输入设备节点并用 `epoll` 读取 `struct input_event`。
3. 识别设备能力（键盘、触摸屏、鼠标等）。
4. 用按键布局映射（`.kl`）和按键字符映射（`.kcm`）文件映射键码。

来自 `frameworks/native/services/inputflinger/reader/EventHub.cpp`：

```cpp
static const char* DEVICE_INPUT_PATH = "/dev/input";
// v4l2 devices go directly into /dev
static const char* DEVICE_PATH = "/dev";

static constexpr size_t EVENT_BUFFER_SIZE = 256;

// Logs if the difference between the event timestamp and the read time is
// greater than this threshold.
static constexpr nsecs_t SLOW_READ_LOG_THRESHOLD_NS = ms2ns(100);
```

EventHub 用 `epoll` 高效地同时等待多个设备文件描述符。当任何设备上有事件到达时，`epoll_wait()` 返回，EventHub 批量读取多达 `EVENT_BUFFER_SIZE`（256）个原始事件。

每个原始事件是 Linux `struct input_event`：

```c
struct input_event {
    struct timeval time;  // Kernel timestamp
    __u16 type;           // EV_KEY, EV_ABS, EV_REL, EV_SYN, ...
    __u16 code;           // KEY_A, ABS_MT_POSITION_X, ...
    __s32 value;          // Key state, coordinate value, ...
};
```

### 12.3.4 InputReader：解释原始事件

InputReader 在自己的线程中运行，并消费来自 EventHub 的原始事件。它维护一组 **InputDevice** 对象，每个对象包含一个或多个 **InputMapper** 实例：

```mermaid
graph TB
    subgraph "InputReader"
        IR[InputReader 线程]
    end

    subgraph "InputDevice：触摸屏"
        MT[MultiTouchInputMapper]
    end

    subgraph "InputDevice：键盘"
        KM[KeyboardInputMapper]
    end

    subgraph "InputDevice：鼠标"
        CM[CursorInputMapper]
    end

    IR --> MT
    IR --> KM
    IR --> CM
```

关键 InputMapper 类型（在 `reader/mapper/`）：

| Mapper | 输入类型 | 输出 |
|--------|-----------|--------|
| `KeyboardInputMapper` | `EV_KEY` 事件 | `NotifyKeyArgs` |
| `MultiTouchInputMapper` | `EV_ABS` 多点触控协议 | `NotifyMotionArgs` |
| `SingleTouchInputMapper` | `EV_ABS` 单点触控协议 | `NotifyMotionArgs` |
| `CursorInputMapper` | `EV_REL` 相对移动 | `NotifyMotionArgs` |
| `TouchpadInputMapper` | 触摸板手势 | `NotifyMotionArgs` |
| `RotaryEncoderInputMapper` | 旋转编码器（手表、汽车） | `NotifyMotionArgs` |
| `SwitchInputMapper` | `EV_SW` 开关事件（盖子、耳机） | `NotifySwitchArgs` |
| `VibratorInputMapper` | 力反馈 / 触觉 | 触觉控制 |

子设备检测合并表示单个物理设备的多个 Linux 输入设备节点（例如带集成触摸板的键盘）：

```cpp
bool isSubDevice(const InputDeviceIdentifier& identifier1,
                 const InputDeviceIdentifier& identifier2) {
    return (identifier1.vendor == identifier2.vendor &&
            identifier1.product == identifier2.product &&
            identifier1.bus == identifier2.bus &&
            identifier1.version == identifier2.version &&
            identifier1.uniqueId == identifier2.uniqueId &&
            identifier1.location == identifier2.location);
}
```

### 12.3.5 流水线阶段

InputReader 产生 `NotifyArgs`（`NotifyKeyArgs` 或 `NotifyMotionArgs`）之后，事件流经几个处理阶段：

**UnwantedInteractionBlocker**

移除无意的触摸，特别是触摸屏上的手掌接触。当在屏幕边缘检测到大接触面积时，拦截器要么移除单个指针，要么抑制整个触摸序列。

**PointerChoreographer**

管理指针图标及其位置。对于触摸板和鼠标输入，它确定指针出现在哪个显示上，并应用多显示设置所需的任何坐标变换。

**InputProcessor**

与设备特定的 `IInputProcessor` HAL 通信以应用硬件辅助的事件分类。例如，HAL 可能把触摸手势分类为手掌误触候选。

**InputDeviceMetricsCollector**

按输入设备收集使用统计：每个设备的使用频率、延迟测量和交互模式。这些数据输入系统的遥测流水线。

**InputFilter**

应用系统定义的过滤规则。它为无障碍功能服务（例如慢速键、粘滞键）。它也服务 `InputFilter` AIDL 接口，让 Rust 组件应用额外的过滤逻辑：

```cpp
mInputFilter = std::make_unique<InputFilter>(
    *mTracingStages.back(), *mInputFlingerRust,
    inputFilterPolicy, vm);
```

### 12.3.6 InputDispatcher：路由到窗口

InputDispatcher 是最后也是最复杂的阶段。它运行在自己的线程中，负责：

1. **窗口定位**：基于触摸坐标和窗口层次确定每个事件应该由哪些窗口接收。
2. **焦点管理**：跟踪哪个窗口拥有按键事件的输入焦点。
3. **ANR 检测**：监控窗口是否在超时窗口内（通常 5 秒）响应事件。
4. **事件注入**：为测试支持程序化事件注入。

来自 `frameworks/native/services/inputflinger/dispatcher/InputDispatcher.h` 的头文件注释：

```cpp
/* Dispatches events to input targets. Some functions of the input
 * dispatcher, such as identifying input targets, are controlled by a
 * separate policy object.
 *
 * IMPORTANT INVARIANT:
 *     Because the policy can potentially block or cause re-entrance
 *     into the input dispatcher, the input dispatcher never calls
 *     into the policy while holding its internal locks.
 */
class InputDispatcher : public android::InputDispatcherInterface {
```

分发器维护几个关键数据结构：

| 数据结构 | 用途 |
|----------------|---------|
| `mInboundQueue` | 等待分发的入站事件 |
| `mConnectionsByToken` | 把窗口 token 映射到 `Connection` 对象 |
| `TouchState`（每显示） | 跟踪进行中的触摸序列 |
| `FocusResolver` | 确定焦点窗口 |
| `AnrTracker` | 监控响应超时 |

```mermaid
sequenceDiagram
    participant WMS as WindowManagerService
    participant SF as SurfaceFlinger
    participant IR as InputReader
    participant ID as InputDispatcher
    participant IMS as InputManagerService 策略
    participant App as 应用窗口

    WMS->>SF: 事务中的窗口信息
    SF->>ID: onWindowInfosChanged(WindowInfosUpdate)
    Note over ID: 窗口句柄缓存在 DispatcherWindowInfo 中
    IR->>ID: notifyMotion(MotionArgs)
    ID->>ID: 排入 mInboundQueue
    ID->>ID: dispatchOnce() 循环唤醒
    ID->>ID: findTouchedWindowAt(displayId, x, y)
    ID->>App: 通过 InputChannel（socket 对）发送
    App-->>ID: Finished 信号
    ID->>ID: 出队，处理下一个

    Note over ID,App: 如果 5 秒内无响应
    ID->>IMS: notifyWindowUnresponsive(token, pid, reason)
```

### 12.3.7 分发器事件类型

InputDispatcher 处理几种类型的事件，定义在 `frameworks/native/services/inputflinger/dispatcher/Entry.h`：

```cpp
struct EventEntry {
    enum class Type {
        DEVICE_RESET,             // Input device was reset
        FOCUS,                    // Focus changed to a new window
        KEY,                      // Keyboard key press/release
        MOTION,                   // Touch, mouse, trackpad motion
        SENSOR,                   // Sensor event (rare)
        POINTER_CAPTURE_CHANGED,  // Pointer capture mode changed
        DRAG,                     // Drag-and-drop state change
        TOUCH_MODE_CHANGED,       // Touch mode toggled

        ftl_last = TOUCH_MODE_CHANGED
    };

    int32_t id;
    Type type;
    nsecs_t eventTime;
    uint32_t policyFlags;
    std::shared_ptr<InjectionState> injectionState;
    mutable bool dispatchInProgress;

    // Injected events are from external (untrusted) sources
    inline bool isInjected() const { return injectionState != nullptr; }

    // Synthesized events aren't directly from hardware
    inline bool isSynthesized() const {
        return isInjected() ||
            IdGenerator::getSource(id) != IdGenerator::Source::INPUT_READER;
    }
};
```

关键特化包括：

- **`KeyEntry`**：包含 `deviceId`、`source`、`displayId`、`action`、`keyCode`、`scanCode`、`metaState`、`repeatCount` 和 `flags`。
- **`MotionEntry`**：包含指针数据数组（`PointerProperties`、`PointerCoords`）、`action`、`actionButton`、`buttonState`、`xPrecision`、`yPrecision` 和 `classification`（例如 palm、ambiguous）。

### 12.3.8 焦点管理

`FocusResolver` 类跟踪每个显示上哪个窗口拥有输入焦点：

> `frameworks/native/services/inputflinger/dispatcher/FocusResolver.h`

```cpp
// Focus Policy:
//   Window focusability - A window token can be focused if there is
//   at least one window handle that is visible with the same token
//   and all window handles with the same token are focusable.
//
//   Focus request - Granted if the window is focusable. If not,
//   persisted and granted when it becomes focusable.
//
//   Conditional focus request - Granted only if the specified focus
//   token is currently focused. Otherwise dropped.
class FocusResolver {
public:
    sp<IBinder> getFocusedWindowToken(
        ui::LogicalDisplayId displayId) const;

    struct FocusChanges {
        sp<IBinder> oldFocus;
        sp<IBinder> newFocus;
        ui::LogicalDisplayId displayId;
        std::string reason;
    };
    // ...
private:
    enum class Focusability {
        OK,
        NO_WINDOW,
        NOT_FOCUSABLE,
        NOT_VISIBLE,
    };
};
```

焦点变更产生 `FocusEntry` 事件，通过与按键和运动事件相同的流水线分发。这确保焦点变更相对于触发它们的事件被正确排序。

### 12.3.9 ANR（应用无响应）检测

InputDispatcher 监控应用是否在超时窗口内响应分发的事件。`AnrTracker` 维护每连接截止时间：

```mermaid
graph LR
    subgraph "InputDispatcher"
        DQ[分发队列]
        AT[AnrTracker]
        WT["等待队列<br/>未确认事件"]
    end

    subgraph "应用"
        IC["InputChannel<br/>socket 对"]
        LP["Looper<br/>主线程"]
    end

    DQ -->|发送事件| IC
    IC -->|写入 socket| LP
    IC -->|添加或移除挂起| WT
    AT -->|监控超时| WT
    LP -->|Finished 信号| IC
```

如果应用在 5 秒内（默认 ANR 超时）没有发送 `finished` 信号，分发器通知策略：

1. 策略（system_server 中的 InputManagerService）显示 ANR 对话框。
2. 用户可以选择等待或强制关闭应用。
3. 如果强制关闭，该窗口的所有挂起事件被取消。

### 12.3.10 触摸状态跟踪

`TouchState` 类按显示跟踪进行中的多点触控交互：

- 当前正在被触摸的窗口。
- "已触摸窗口"集合——收到 `ACTION_DOWN` 并应持续接收运动事件直到 `ACTION_UP` 的窗口。
- 拆分运动支持——单个触摸流可以拆分到多个窗口（例如拖拽跨越窗口边界时）。
- 用于多点触控消歧的指针 ID 跟踪。

`TouchedWindow` 类存储每窗口触摸信息：

```
frameworks/native/services/inputflinger/dispatcher/TouchedWindow.h
frameworks/native/services/inputflinger/dispatcher/TouchState.h
```

### 12.3.11 InputChannels 与传输

事件通过 **InputChannels**——Unix 域 socket 对——交付给应用。一端由 InputDispatcher 持有，另一端传给应用进程。`InputTransport` 协议定义一种零拷贝优化的二进制消息格式：

- **`InputMessage::Type::MOTION`**：带坐标的触摸/鼠标事件。
- **`InputMessage::Type::KEY`**：带键码的键盘事件。
- **`InputMessage::Type::FINISHED`**：应用确认接收。
- **`InputMessage::Type::TIMELINE`**：帧时序反馈。

基于 socket 的传输避免了高频输入事件流的 Binder IPC 开销。典型触摸屏以 120-240 Hz 产生事件，Binder 往返会引入不可接受的延迟。

### 12.3.12 事件注入

InputDispatcher 为测试和无障碍支持事件注入：

```mermaid
graph LR
    subgraph "注入源"
        ADB[adb input]
        INST[Instrumentation]
        A11Y[无障碍服务]
        TEST[UI Automator]
    end

    subgraph "InputDispatcher"
        IJ[injectInputEvent]
        IJS[InjectionState]
        Q[mInboundQueue]
    end

    ADB --> IJ
    INST --> IJ
    A11Y --> IJ
    TEST --> IJ
    IJ --> IJS
    IJS --> Q
```

注入的事件用 `POLICY_FLAG_INJECTED` 标记并通过 `InjectionState` 对象跟踪。分发器可以等待注入完成（同步模式）或立即返回（异步模式）。

权限检查确保只有特权调用者可以注入事件：

- 常规注入需要 `INJECT_EVENTS` 权限。
- 无障碍服务对无障碍 overlay 有特殊注入特权。
- `adb shell input` 使用 shell UID 的注入权限。

### 12.3.13 延迟跟踪

InputDispatcher 包含一个测量端到端输入延迟的 `LatencyTracker`：

```
// From LatencyTracker.h / LatencyAggregator.h
// Tracks the timeline for each event:
// 1. Event creation time (kernel timestamp)
// 2. Event read time (EventHub)
// 3. Dispatch time (InputDispatcher)
// 4. Delivery time (written to InputChannel)
// 5. Consumption time (app reads from channel)
// 6. Finish time (app sends finished signal)
// 7. Graphics latency (frame presented on display)
```

`LatencyAggregatorWithHistograms` 产生直方图数据，上报给系统的遥测流水线，支持：

- 检测输入延迟持续偏高的应用。
- 识别系统性延迟回归。
- 设备级输入性能基准测试。

### 12.3.14 Rust 组件

当前 AOSP 中一个值得注意的架构演进是通过 `IInputFlingerRust` 把 Rust 引入输入流水线：

```cpp
// Create the Rust component of InputFlinger that uses AIDL interfaces
// as the foreign function interface (FFI).
std::shared_ptr<IInputFlingerRust> createInputFlingerRust() {
    // ...
    create_inputflinger_rust(binderToPointer(*callback));
    // ...
}
```

Rust 实现通过 C++ 回调模式引导：

1. C++ 创建 `BnInputFlingerRustBootstrapCallback`。
2. 调用 CXX bridge 函数 `create_inputflinger_rust()`。
3. Rust 侧创建 `IInputFlingerRust` 实现。
4. 通过回调把它传回 C++。

这种混合方法让新的输入过滤和处理逻辑可以用 Rust 编写，享有其内存安全保证。现有 C++ 基础设施保持原样。

### 12.3.15 InputManager 绑定

`InputManager` 类把所有东西串起来并实现 `BnInputFlinger` Binder 接口：

> `frameworks/native/services/inputflinger/InputManager.h`

```cpp
class InputManager : public InputManagerInterface, public BnInputFlinger {
private:
    std::unique_ptr<InputReaderInterface> mReader;
    std::unique_ptr<UnwantedInteractionBlockerInterface> mBlocker;
    std::unique_ptr<InputFilterInterface> mInputFilter;
    std::unique_ptr<PointerChoreographerInterface> mChoreographer;
    std::unique_ptr<InputProcessorInterface> mProcessor;
    std::unique_ptr<InputDeviceMetricsCollectorInterface> mCollector;
    std::unique_ptr<InteractionReporterInterface> mInteractionReporter;
    std::unique_ptr<InputDispatcherInterface> mDispatcher;
    std::shared_ptr<IInputFlingerRust> mInputFlingerRust;
    std::vector<std::unique_ptr<TracedInputListener>> mTracingStages;
};
```

`start()` 方法启动 reader 和 dispatcher 线程：

```cpp
status_t InputManager::start() {
    status_t result = mDispatcher->start();
    if (result) {
        ALOGE("Could not start InputDispatcher thread due to error %d.", result);
        return result;
    }
    result = mReader->start();
    if (result) {
        ALOGE("Could not start InputReader due to error %d.", result);
        mDispatcher->stop();
        return result;
    }
    return OK;
}
```

InputManager 不是独立进程——它由 `system_server` 中的 `InputManagerService` 通过 JNI 创建和拥有。不过，整个 C++ 流水线在 `system_server` 进程内的原生线程中运行。

---

## 12.4 AudioFlinger 概览

AudioFlinger 是负责混合和路由音频流的原生服务。它作为独立进程（`audioserver`）运行。它是 Android 中最成熟的原生服务之一，其根源可以追溯到平台最早版本。

### 12.4.1 源码位置

AudioFlinger 实现位于：

```
frameworks/av/services/audioflinger/
```

关键文件包括：

| 文件 | 用途 |
|------|---------|
| `AudioFlinger.h` / `.cpp` | 主服务实现 |
| `Threads.h` / `.cpp` | 播放和录音线程管理 |
| `Tracks.cpp` | 音频 track 生命周期和混合 |
| `Effects.h` / `.cpp` | 音效链处理 |
| `PatchPanel.h` / `.cpp` | 音频路由 patch 管理 |
| `MelReporter.h` / `.cpp` | 声音剂量测量（瞬时暴露级） |
| `DeviceEffectManager.h` / `.cpp` | 每设备音效 |
| `Client.h` / `.cpp` | 每客户端状态跟踪 |

### 12.4.2 架构概览

```mermaid
graph TB
    subgraph "应用"
        AT1[AudioTrack 1]
        AT2[AudioTrack 2]
        AR[AudioRecord]
    end

    subgraph "AudioFlinger（audioserver）"
        AF[AudioFlinger]
        PT["PlaybackThread<br/>MixerThread"]
        RT[RecordThread]
        EF[Effects Chain]
        PP[PatchPanel]
    end

    subgraph "HAL"
        AHAL["Audio HAL<br/>AIDL/HIDL"]
    end

    AT1 -->|共享内存| PT
    AT2 -->|共享内存| PT
    PT --> EF
    EF --> AHAL
    PP -.->|"配置路由（patches）"| PT
    PP -.->|"配置路由（patches）"| RT
    AHAL --> RT
    RT -->|共享内存| AR
```

注意 `PatchPanel` 位于控制路径上，而不是数据路径上。它创建和拆除决定每个线程连接到哪个 HAL 设备的音频 patch。播放线程把混合后的 PCM 数据直接写入其 HAL 输出流。

AudioFlinger 使用共享内存（ashmem/memfd）缓冲区在应用和混合线程之间进行零拷贝音频数据传输。这对维持低音频延迟至关重要。

线程模型基于专门化线程类：

- **`MixerThread`**：最常见的播放线程。用软件混音器混合多个音频 track（或卸载到硬件）。
- **`DirectOutputThread`**：不经软件混音直接把单个 track 发送到 HAL（用于压缩音频透传）。
- **`OffloadThread`**：用于硬件卸载的音频解码和播放。
- **`RecordThread`**：从输入设备捕获音频。
- **`MmapThread`**：用内存映射 I/O 实现超低延迟路径（AAudio MMAP 模式）。

### 12.4.3 AudioFlinger 线程模型

AudioFlinger 的线程架构是理解其设计的核心。每个音频输出设备（扬声器、耳机、蓝牙、USB）通常有一个或多个专用线程：

```mermaid
graph TB
    subgraph "AudioFlinger"
        direction TB
        subgraph "输出设备"
            MT1["MixerThread<br/>扬声器"]
            MT2["MixerThread<br/>耳机"]
            DOT["DirectOutputThread<br/>HDMI 透传"]
            OT["OffloadThread<br/>DSP 解码"]
            MMAP["MmapPlaybackThread<br/>AAudio MMAP"]
        end

        subgraph "输入设备"
            RT1["RecordThread<br/>内置麦克风"]
            RT2["RecordThread<br/>USB 麦克风"]
            MMAPR["MmapCaptureThread<br/>AAudio MMAP"]
        end

        PP["PatchPanel<br/>音频路由"]
        EC["Effect Chains<br/>每线程"]
    end

    PP -.->|路由| MT1
    PP -.->|路由| MT2
    PP -.->|路由| DOT
    PP -.->|路由| OT
    PP -.->|路由| RT1
    PP -.->|路由| RT2
    EC -.->|附加到| MT1
    EC -.->|附加到| MT2
```

**MixerThread** 是主力。它在一个紧密循环中运行：

1. 等待下一个缓冲周期（通常 5-20ms）。
2. 从所有活跃 `Track` 对象拉取数据（通过共享内存环形缓冲区）。
3. 把所有 track 混合在一起，应用每 track 音量、声像和辅助效果。
4. 应用输出效果（均衡器、低音增强、虚拟化等）。
5. 把混合后的缓冲区写入 Audio HAL。

**DirectOutputThread** 对不应混合的格式（例如发送给 HDMI 接收器解码的压缩音频）绕过混音器。

**OffloadThread** 把解码委托给音频 DSP，让应用处理器在播放期间休眠。这对音乐播放期间的电池寿命至关重要。

**MmapThread** 通过把 HAL 的缓冲区直接映射到应用的地址空间提供尽可能低的延迟，消除所有拷贝操作。专业音频应用使用 AAudio MMAP 模式就是利用这一点。

### 12.4.4 共享内存音频传输

AudioFlinger 使用共享内存进行零拷贝音频数据传输：

```mermaid
sequenceDiagram
    participant App as 应用
    participant SM as 共享内存环形缓冲区
    participant AF as AudioFlinger MixerThread

    App->>SM: 写入音频帧
    App->>SM: 更新写指针
    Note over SM: 无锁 FIFO
    AF->>SM: 读取音频帧
    AF->>SM: 更新读指针
    AF->>AF: 与其他 track 混合
    AF->>AF: 写入 Audio HAL
```

共享内存区域包含：

- 带读写指针和流控标志的**控制块**。
- 用于音频数据（PCM 样本）的**环形缓冲区**。
- 用于在缓冲区满（生产者）或空（消费者）时高效阻塞的流控 **futex**。

这种设计把 Binder IPC 完全排除在音频数据路径之外。只有控制操作（开始、停止、设置音量）使用 Binder——实际音频数据通过共享内存流动，内核介入最少。

### 12.4.5 交叉引用

深入了解 AudioFlinger 的混合流水线、效果链、延迟优化和 Audio HAL 接口，见**第 15 章（音频系统）**。该章覆盖：

- 完整音频路由模型和 `AudioPolicy` 交互。
- 共享内存环形缓冲区和 `AudioTrack`/`AudioRecord` 协议。
- 效果处理链和 `EffectModule` 架构。
- AAudio/MMAP 低延迟路径。
- Audio HAL 版本化（HIDL 到 AIDL 迁移）。

---

## 12.5 CameraService 概览

CameraService 管理所有相机硬件访问，是确保多个应用能安全共享相机资源的守门员。

### 12.5.1 源码位置

CameraService 源码位于：

```
frameworks/av/services/camera/libcameraservice/
```

关键文件：

| 文件 | 用途 |
|------|---------|
| `CameraService.h` / `.cpp` | 主服务、客户端管理 |
| `CameraFlashlight.h` / `.cpp` | 手电筒/闪光灯控制 |
| `CameraServiceWatchdog.h` / `.cpp` | 检测并从 HAL 挂起中恢复 |

一个有趣的近期新增是位于以下位置的**虚拟相机**子系统：

```
frameworks/av/services/camera/virtualcamera/
```

它为测试、远程相机和虚拟显示提供基于软件的相机设备。

### 12.5.2 架构概览

```mermaid
graph TB
    subgraph "应用"
        App1[相机应用]
        App2[视频通话应用]
    end

    subgraph "CameraService（cameraserver）"
        CS[CameraService]
        WD[Watchdog]
        FL[闪光灯控制]
    end

    subgraph "Camera HAL"
        Provider[ICameraProvider]
        Device[ICameraDevice]
        Session[ICameraDeviceSession]
    end

    subgraph "虚拟相机"
        VCP[VirtualCameraProvider]
        VCD[VirtualCameraDevice]
        VCS[VirtualCameraSession]
    end

    App1 --> CS
    App2 --> CS
    CS --> Provider
    Provider --> Device
    Device --> Session
    CS --> VCP
    VCP --> VCD
    WD -.->|监控| CS
```

CameraService 强制严格的资源仲裁：

- 默认一次只有一个客户端可以使用相机设备（前台与后台应用之间基于优先级的驱逐）。不过，CameraService 也支持共享模式（connect 上的 `sharedMode` 标志）。在此模式下多个客户端共享一个相机设备。
- `CameraServiceWatchdog` 监控 HAL 响应，如果 HAL 变得无响应则触发恢复。
- 相机访问受 `android.permission.CAMERA` 和 AppOps 检查约束。

### 12.5.3 客户端优先级与驱逐

CameraService 实现基于优先级的驱逐系统。当高优先级客户端请求一个已被低优先级客户端使用的相机时，低优先级客户端被驱逐：

```mermaid
graph TD
    subgraph "优先级级别（从高到低）"
        PERS["持久 / System UI 进程"]
        TOP["顶层 Activity<br/>前台、聚焦"]
        BTOP[Bound-Top 进程]
        FGS[前台服务]
        BG[后台进程]
        IDLE[缓存/空闲进程]
    end

    PERS --> TOP
    TOP --> BTOP
    BTOP --> FGS
    FGS --> BG
    BG --> IDLE
```

这些级别不是 CameraService 内部手工搭建的阶梯。每个客户端的优先级是 `(oom 优先级分数, 进程状态)` 对。CameraService 通过 `ProcessInfoService` 从 ActivityManager 获取这对值。较低的进程状态值胜出。`PROCESS_STATE_TOP` 和 `PROCESS_STATE_BOUND_TOP` 高于 `PROCESS_STATE_FOREGROUND_SERVICE`，持久状态高于所有这些。

驱逐算法：

1. 新客户端请求相机。
2. CameraService 检查相机当前是否在使用中。
3. 如果在使用中，比较新客户端的优先级（基于其进程状态）与当前客户端的优先级。
4. 如果新客户端优先级更高，断开旧客户端并连接新客户端。
5. 旧客户端收到 `disconnect()` 回调并必须释放所有资源。

这确保前台相机应用总是优先于后台进程。它也确保系统级相机访问（例如人脸解锁）优先于所有用户应用。

### 12.5.4 CameraServiceWatchdog

watchdog 监控 HAL 挂起，这是复杂相机硬件的常见故障模式：

```cpp
class CameraServiceWatchdog {
    // Monitors camera operations and aborts the process if they exceed
    // the default timeout of 65 seconds
    // (kMaxCycles = 650 cycles of kCycleLengthMs = 100 ms)
};
```

当 HAL 操作耗时过长时：

1. watchdog 设置一个命名卡住函数的 abort 消息（`android_set_abort_message()`）。
2. 它向 camera HAL provider 进程发送 `SIGABRT`，并对 cameraserver 自身调用 `abort()`，这样会为调试产生 tombstone。
3. `init` 重启 cameraserver，已连接客户端观察到 binder 死亡。
4. 客户端重连时重新打开 HAL。

### 12.5.5 虚拟相机

虚拟相机子系统（`frameworks/av/services/camera/virtualcamera/`）提供软件实现的相机设备。关键组件：

| 类 | 用途 |
|-------|---------|
| `VirtualCameraProvider` | 为虚拟相机实现 `ICameraProvider` |
| `VirtualCameraDevice` | 实现 `ICameraDevice` |
| `VirtualCameraSession` | 实现 `ICameraDeviceSession` |
| `VirtualCameraRenderThread` | 从各种来源生成相机帧 |
| `VirtualCameraStream` | 管理输出流 |

虚拟相机可以来自：

- 屏幕捕获（用于远程桌面场景）。
- 网络流（用于 IP 相机或远程协作）。
- 合成内容（用于测试和开发）。
- 显示输出（用于折叠屏的后置显示屏相机）。

### 12.5.6 交叉引用

完整覆盖 Camera HAL 接口、捕获流水线、流配置和 Camera2 API，见**第 16 章（媒体与相机）**。该章覆盖：

- `ICameraDevice` / `ICameraDeviceSession` AIDL HAL 接口。
- 请求/结果元数据处理。
- 流配置和缓冲区管理。
- 多相机支持和并发访问。

---

## 12.6 MediaService 概览

媒体子系统被拆分到几个原生服务中，每个服务在自己的进程中以受限权限运行（使用 seccomp 沙箱）。

### 12.6.1 MediaCodecService

这是遗留编解码器服务。二进制名为 `android.hardware.media.omx@1.0-service`，启动时只把它的 `argv[0]` 改名为 `media.codec`。它是仅 vendor、32 位 HIDL HAL，注册 `IOmx`/`IOmxStore` 接口，所以它与现代 Codec2 路径无关。它用 seccomp-bpf 沙箱限制系统调用：

> `frameworks/av/services/mediacodec/main_codecservice.cpp`

```cpp
int main(int argc __unused, char** argv) {
    strcpy(argv[0], "media.codec");
    LOG(INFO) << "mediacodecservice starting";
    signal(SIGPIPE, SIG_IGN);
    SetUpMinijail(kSystemSeccompPolicyPath, kVendorSeccompPolicyPath);

    android::ProcessState::initWithDriver("/dev/vndbinder");
    android::ProcessState::self()->startThreadPool();

    ::android::hardware::configureRpcThreadpool(64, false);

    // Default codec services
    using namespace ::android::hardware::media::omx::V1_0;
    sp<IOmx> omx = new implementation::Omx();
    // ...
    ::android::hardware::joinRpcThreadpool();
}
```

关键观察：

- 使用 `/dev/vndbinder`（vendor binder），把它放在 vendor 域中。
- 配置 64 个 RPC 线程用于并行编解码操作。
- 应用来自 `/system/etc/seccomp_policy/` 的 minijail seccomp 策略。
- 为基于 OMX 的编解码器注册 `IOmx` HAL 接口。

OMX 是遗留且已弃用的；这个服务只为较老的 vendor 编解码器 HAL 存活。当前路径是 `mediaswcodec` 二进制（`main_swcodecservice.cpp`，`argv[0]` 改名为 `media.swcodec`）。它调用 `RegisterCodecServices()` 通过第 12.6.3 节描述的 Codec2（C2）框架暴露软件编解码器。这让软件编解码器与硬件编解码器驱动隔离。

### 12.6.2 MediaExtractorService

媒体提取器以 `media.extractor` 运行，负责解析容器格式（MP4、MKV、OGG 等）并把它们解复用到基本流。与编解码器服务一样，它在 seccomp 沙箱进程中运行。

### 12.6.3 Codec2（C2）框架

现代编解码器框架是 Codec2（C2），位于：

```
frameworks/av/media/codec2/
```

Codec2 用更灵活的架构取代较老的 OMX（OpenMAX IL）接口：

```mermaid
graph LR
    MC[MediaCodec API] --> C2[Codec2 框架]
    C2 --> C2Comp[C2Component]
    C2Comp --> HW[硬件编解码器 HAL]
    C2Comp --> SW["软件编解码器<br/>例如 AOM、VPX"]

    MC --> OMX["遗留 OMX<br/>已弃用"]
    OMX --> OMXHAL[OMX HAL]
```

Codec2 提供：

- **基于组件的架构**：每个编解码器是一个具有明确定义输入/输出工作队列的 `C2Component`。
- **缓冲区池管理**：高效的缓冲区分配和回收。
- **Tunneled 播放**：解码器和 SurfaceFlinger 之间不经 CPU 拷贝直接传递缓冲区。
- **多实例支持**：并发运行多个编解码器实例。

### 12.6.4 进程隔离架构

媒体服务展示 Android 的纵深防御方法。每个媒体服务在自己的进程中以受限特权运行：

```mermaid
graph TB
    subgraph "媒体进程"
        direction LR
        MC["media.codec<br/>seccomp + vndbinder"]
        ME["media.extractor<br/>seccomp + binder"]
        SWMC["media.swcodec<br/>seccomp + binder"]
        MS["mediaserver<br/>binder"]
    end

    subgraph "隔离措施"
        direction TB
        SEC["seccomp-bpf<br/>系统调用过滤"]
        MJ["Minijail<br/>特权限制"]
        SEL["SELinux<br/>强制访问控制"]
        NS[命名空间隔离]
    end

    MC --- SEC
    MC --- MJ
    MC --- SEL
    ME --- SEC
    ME --- MJ
    SWMC --- SEC
    SWMC --- MJ
```

这种隔离的理由：

- **媒体解析器（extractor）**是恶意媒体文件的主要攻击面。精心构造的 MP4/MKV 文件可能利用解析器 bug。在沙箱进程中运行解析器限制了此类利用的影响。
- **硬件编解码器**与可能有自己漏洞的 vendor 特定驱动交互。使用 `/dev/vndbinder` 把它们与 framework 服务隔离。
- **软件编解码器**历来是漏洞来源（例如 Stagefright）。把它们在与硬件编解码器分离的进程中运行，防止软件编解码器漏洞访问硬件编解码器驱动。

seccomp 策略文件把系统调用限制到所需的最小集合：

```
/system/etc/seccomp_policy/mediacodec.policy
/vendor/etc/seccomp_policy/mediacodec.policy
```

### 12.6.5 Codec2 组件生命周期

Codec2 组件经历明确定义的生命周期。`frameworks/av/media/codec2/core/include/C2Component.h` 中记录的状态是 **released**、**stopped** 和 **running**，其中 **tripped** 和 **error** 是 running 的子状态：

```mermaid
stateDiagram-v2
    [*] --> released
    released --> stopped: create
    stopped --> running: start
    running --> running
    running --> stopped: stop
    running --> tripped: limit tripped
    running --> error: fatal error
    tripped --> stopped: reset
    error --> stopped: reset
    stopped --> released: release
    released --> [*]
```

running 上的自转换是组件做工作的地方。它在那里处理排队的工作项。没有单独的 flushing 状态，因为 `flush()` 在组件保持 running 状态时被调用。

组件从输入队列处理工作项：

1. 客户端提交包含输入缓冲区的 `C2Work` 项。
2. 组件处理每个工作项（解码/编码）。
3. 完成的工作项带着输出缓冲区返回给客户端。
4. 客户端读取输出数据并回收缓冲区。

### 12.6.6 交叉引用

完整媒体流水线架构，包括 `MediaCodec`、`MediaPlayer`、`MediaRecorder` 和 Codec2 内部细节，见**第 16 章（媒体与相机）**。

---

## 12.7 installd

`installd` 是负责所有与应用安装、数据管理和 DEX 优化相关的磁盘操作的特权守护进程。它以 `system_server` 自身没有的提升权限运行，为包管理操作提供安全升级路径。

### 12.7.1 installd 为何存在

`system_server` 以 UID `system`（1000）运行，但应用数据目录由每应用 UID（10000+）拥有。创建、修改和删除这些目录需要 root 或特定 capabilities。Android 不给 `system_server` 这些特权，而是把文件系统操作委托给 `installd`，它以 root 运行，带受限 capabilities 和 SELinux 强制。

### 12.7.2 源码布局

源码在 `frameworks/native/cmds/installd/`：

| 文件 | 用途 |
|------|---------|
| `installd.cpp` | 主入口点、初始化 |
| `InstalldNativeService.h` / `.cpp` | Binder 服务实现 |
| `dexopt.h` / `.cpp` | DEX 优化（dex2oat 调用） |
| `utils.cpp` | 文件系统工具函数 |
| `CacheTracker.h` | 存储管理的缓存大小跟踪 |
| `QuotaUtils.h` / `.cpp` | 磁盘配额管理 |
| `CrateManager.cpp` | "Crate" 存储管理 |
| `run_dex2oat.cpp` | dex2oat 进程派生 |
| `installd_constants.h` | 共享常量和标志 |
| `globals.h` | 全局路径变量 |

### 12.7.3 启动与初始化

`installd` 主函数在接受 Binder 调用之前执行仔细的初始化：

> `frameworks/native/cmds/installd/installd.cpp`

```cpp
static int installd_main(const int argc ATTRIBUTE_UNUSED, char *argv[]) {
    // ...
    SLOGI("installd firing up");

    // SELinux setup
    union selinux_callback cb;
    cb.func_log = log_callback;
    selinux_set_callback(SELINUX_CB_LOG, cb);

    if (!initialize_globals()) {
        SLOGE("Could not initialize globals; exiting.\n");
        exit(1);
    }

    if (initialize_directories() < 0) {
        SLOGE("Could not create directories; exiting.\n");
        exit(1);
    }

    if (selinux_enabled && selinux_status_open(true) < 0) {
        SLOGE("Could not open selinux status; exiting.\n");
        exit(1);
    }

    if ((ret = InstalldNativeService::start()) != android::OK) {
        SLOGE("Unable to start InstalldNativeService: %d", ret);
        exit(1);
    }

    IPCThreadState::self()->joinThreadPool();
    // ...
}
```

`initialize_directories()` 函数处理文件系统布局升级。它读取 `{android_data_dir}/misc/installd/layout_version` 的版本文件，并在布局版本变化时执行迁移：

```cpp
if (version < 2) {
    SLOGD("Assuming that device has multi-user storage layout; "
          "upgrade no longer supported");
    version = 2;
}
```

### 12.7.4 InstalldNativeService 接口

`InstalldNativeService` 实现 `IInstalld` AIDL 接口，向 `PackageManagerService` 暴露数十个操作：

> `frameworks/native/cmds/installd/InstalldNativeService.h`

```cpp
class InstalldNativeService : public BinderService<InstalldNativeService>,
                              public os::BnInstalld {
public:
    static char const* getServiceName() { return "installd"; }

    // User data management
    binder::Status createUserData(const std::optional<std::string>& uuid,
            int32_t userId, int32_t userSerial, int32_t flags);
    binder::Status destroyUserData(const std::optional<std::string>& uuid,
            int32_t userId, int32_t flags);

    // App data management
    binder::Status createAppData(/* ... */);
    binder::Status createAppDataBatched(/* ... */);
    binder::Status clearAppData(/* ... */);
    binder::Status destroyAppData(/* ... */);

    // DEX optimization
    binder::Status dexopt(const std::string& apkPath, int32_t uid,
                          /* ... 14 more parameters ... */);

    // Storage management
    binder::Status freeCache(/* ... */);
    binder::Status getAppSize(/* ... */);
    binder::Status getUserSize(/* ... */);

    // Profile management
    binder::Status mergeProfiles(/* ... */);
    binder::Status dumpProfiles(/* ... */);

    // fs-verity
    binder::Status createFsveritySetupAuthToken(/* ... */);
    binder::Status enableFsverity(/* ... */);
    // ... and many more
};
```

### 12.7.5 应用数据目录结构

当应用被安装时，`installd` 创建以下目录结构：

```
/data/user/{userId}/{packageName}/      （CE - 凭据加密）
/data/user_de/{userId}/{packageName}/   （DE - 设备加密）
```

CE（凭据加密）和 DE（设备加密）存储之间的区别对 Direct Boot 支持至关重要：

| 存储 | 可用时机 | 用例 |
|---------|-----------|----------|
| CE | 用户解锁后 | 应用数据库、用户文件 |
| DE | 设备启动后（解锁前） | 闹钟数据、通知渠道 |

标志在 `installd_constants.h` 中定义：

```cpp
// NOTE: keep in sync with StorageManager
constexpr int FLAG_STORAGE_DE = 1 << 0;
constexpr int FLAG_STORAGE_CE = 1 << 1;
```

### 12.7.6 DEX 优化（dexopt）

`installd` 最重要的职责之一是调用 `dex2oat` 把 DEX 字节码编译成原生机器码。`dexopt()` 函数接受大量参数：

> `frameworks/native/cmds/installd/dexopt.h`

```cpp
int dexopt(const char *apk_path, uid_t uid, const char *pkgName,
        const char *instruction_set, int dexopt_needed,
        const char* oat_dir, int dexopt_flags,
        const char* compiler_filter, const char* volume_uuid,
        const char* class_loader_context, const char* se_info,
        bool downgrade, int target_sdk_version,
        const char* profile_name, const char* dexMetadataPath,
        const char* compilation_reason, std::string* error_msg,
        /* out */ bool* completed = nullptr);
```

dex2oat 二进制位于 ART APEX 中：

```cpp
#define ANDROID_ART_APEX_BIN "/apex/com.android.art/bin"
static constexpr const char* kDex2oat32Path = ANDROID_ART_APEX_BIN "/dex2oat32";
static constexpr const char* kDex2oat64Path = ANDROID_ART_APEX_BIN "/dex2oat64";
static constexpr const char* kDex2oatDebug32Path = ANDROID_ART_APEX_BIN "/dex2oatd32";
static constexpr const char* kDex2oatDebug64Path = ANDROID_ART_APEX_BIN "/dex2oatd64";
```

dexopt 标志控制编译行为：

```cpp
constexpr int DEXOPT_PUBLIC         = 1 << 1;   // Shared library (world-readable)
constexpr int DEXOPT_DEBUGGABLE     = 1 << 2;   // Include debug info
constexpr int DEXOPT_BOOTCOMPLETE   = 1 << 3;   // Boot has finished
constexpr int DEXOPT_PROFILE_GUIDED = 1 << 4;   // Use profile for compilation
constexpr int DEXOPT_SECONDARY_DEX  = 1 << 5;   // Secondary DEX file
constexpr int DEXOPT_FORCE          = 1 << 6;   // Force recompilation
constexpr int DEXOPT_STORAGE_CE     = 1 << 7;   // CE storage
constexpr int DEXOPT_STORAGE_DE     = 1 << 8;   // DE storage
constexpr int DEXOPT_IDLE_BACKGROUND_JOB = 1 << 9;  // Background optimization
constexpr int DEXOPT_ENABLE_HIDDEN_API_CHECKS = 1 << 10;
constexpr int DEXOPT_GENERATE_COMPACT_DEX = 1 << 11;
constexpr int DEXOPT_GENERATE_APP_IMAGE = 1 << 12;
```

dexopt needed 级别决定所需编译类型：

```cpp
static constexpr int NO_DEXOPT_NEEDED            = 0;  // Already optimized
static constexpr int DEX2OAT_FROM_SCRATCH        = 1;  // Full compilation
static constexpr int DEX2OAT_FOR_BOOT_IMAGE      = 2;  // Boot image changed
static constexpr int DEX2OAT_FOR_FILTER          = 3;  // Compiler filter changed
```

### 12.7.7 配置（Profile）管理

`installd` 管理引导配置引导优化（PGO）的 ART profile：

1. **当前 profile**：记录运行时执行了哪些方法的每用户 profile（`/data/misc/profiles/cur/{userId}/{packageName}/primary.prof`）。
2. **参考 profile**：用作 dex2oat 输入的合并 profile（`/data/misc/profiles/ref/{packageName}/primary.prof`）。

`mergeProfiles()` 操作把当前 profile 合并到参考 profile。当合并后的 profile 表明显著变化时，系统调度后台 dexopt 用更新的 profile 数据重新编译应用。

profile 分析的结果之一是：

```cpp
constexpr int PROFILES_ANALYSIS_OPTIMIZE                     = 1;
constexpr int PROFILES_ANALYSIS_DONT_OPTIMIZE_SMALL_DELTA    = 2;
constexpr int PROFILES_ANALYSIS_DONT_OPTIMIZE_EMPTY_PROFILES = 3;
```

### 12.7.8 dexopt 流程

从包安装到优化代码的完整 dexopt 流程：

```mermaid
sequenceDiagram
    participant PMS as PackageManagerService
    participant INS as installd（IInstalld）
    participant D2O as dex2oat 进程
    participant ART as ART 运行时

    PMS->>INS: createAppData(uuid, pkg, userId, ...)
    INS->>INS: mkdir /data/user/{userId}/{pkg}/
    INS->>INS: chown 到应用 UID
    INS->>INS: restorecon（SELinux 标签）

    PMS->>INS: dexopt(apkPath, uid, pkgName, isa, ...)
    INS->>INS: 确定 dex2oat 二进制（32/64 位）
    INS->>INS: 打开 profile 文件（如果 PGO）
    INS->>INS: 创建输出 .oat/.art/.vdex 文件
    INS->>D2O: fork + exec dex2oat
    D2O->>D2O: 解析 DEX 字节码
    D2O->>D2O: 应用编译器过滤器（speed、speed-profile 等）
    D2O->>D2O: 生成原生机器码
    D2O->>D2O: 写 .oat（代码）、.art（映像）、.vdex（dex）
    D2O-->>INS: 退出码
    INS-->>PMS: 返回成功/失败

    Note over ART: 在应用启动时...
    ART->>ART: 加载 .oat 文件获取预编译方法
    ART->>ART: 按需 JIT 其余方法
```

编译器过滤器决定优化级别：

| 过滤器 | 行为 | 用例 |
|--------|----------|----------|
| `verify` | 只验证 DEX，不编译 | 首次安装（最小延迟） |
| `speed` | 完整 AOT 编译 | 后台优化 |
| `speed-profile` | 只对 profile 中的热方法 AOT | 大小/速度的最佳平衡 |
| `everything` | 编译所有方法 | 测试/基准测试 |

（旧的 `quicken` 过滤器已过时：ART 现在把它映射到 `verify` 并给出弃用警告，它不执行任何字节码优化。）

`dex2oat` 进程作为 `installd` 的子进程运行。它继承受限 capabilities 并受资源限制（CPU、内存）约束。当作为后台任务（`DEXOPT_IDLE_BACKGROUND_JOB`）运行时，`dex2oat` 使用较低 CPU 优先级，并且可能包含额外调试信息。

### 12.7.9 存储管理

`installd` 跨多个卷和用户管理存储：

```mermaid
graph TB
    subgraph "内部存储"
        DATA["/data"]
        U0["/data/user/0<br/>（主用户）"]
        U10["/data/user/10<br/>（工作资料）"]
        DE0["/data/user_de/0<br/>（设备加密）"]
        DE10["/data/user_de/10"]
        PROF["/data/misc/profiles"]
        DALVIK["/data/dalvik-cache"]
    end

    subgraph "外部存储"
        EXT["/data/media/0"]
    end

    subgraph "每应用布局"
        direction TB
        CE_APP["CE：/data/user/0/{pkg}/"]
        DE_APP["DE：/data/user_de/0/{pkg}/"]
        CACHE["cache/"]
        CODE_CACHE["code_cache/"]
        FILES["files/"]
        DB["databases/"]
        SP["shared_prefs/"]
    end

    DATA --> U0
    DATA --> U10
    DATA --> DE0
    DATA --> DE10
    DATA --> PROF
    DATA --> DALVIK

    U0 --> CE_APP
    DE0 --> DE_APP
    CE_APP --> CACHE
    CE_APP --> CODE_CACHE
    CE_APP --> FILES
    CE_APP --> DB
    CE_APP --> SP
```

当磁盘空间不足时调用 `freeCache()` 方法，它按 UID 而非全局按年龄挑选清理对象（`frameworks/native/cmds/installd/InstalldNativeService.cpp:2439`）。它为每个已知 UID 构建一个 `CacheTracker` 并加载每个 tracker 的统计。它把 tracker 推入按 `getCacheRatio()`——该 UID 超出其分配缓存配额的幅度——排序的优先级队列。

接下来它在队列中跳跃式处理。它从当前超配额最严重的 UID 清除项目，并在每步之后重新检查，直到达到目标可用空间。除非调用者传入 `FLAG_FREE_CACHE_V2_DEFY_QUOTA`，否则一旦活跃 tracker 的比例降到配额以下循环就停止。结果，保持在配额内的应用不会被触碰。

修改时间戳仍然重要，但只在 tracker **内部**：`CacheTracker::loadItems()` 把该 UID 的项目按最新优先排序，所以最旧的先被删除。旧的非配额代码路径已经消失——没有 `FLAG_FREE_CACHE_V2` 的调用现在返回 `"Legacy cache logic no longer supported"`。

磁盘配额通过 `QuotaUtils` 模块（`frameworks/native/cmds/installd/QuotaUtils.h`）管理。它是建立在 Linux 文件系统配额系统之上的一组免费辅助函数，在文件系统支持时使用：

```cpp
// From QuotaUtils.h
// Whether quota is supported in the device with the given uuid
bool IsQuotaSupported(const std::string& uuid);

// Get the current occupied space in bytes for a uid or -1 if fails
int64_t GetOccupiedSpaceForUid(const std::string& uuid, uid_t uid);

// Ensure a hard-limit inode quota to protect against abusive apps
bool PrepareAppInodeQuota(const std::string& uuid, uid_t uid);
```

`InstalldNativeService` 调用这些辅助函数，通过 Binder 暴露能力检查，并自己跟踪每 UID 缓存配额：

```cpp
// From InstalldNativeService.h
// Check if the given UUID volume supports disk quotas
binder::Status isQuotaSupported(const std::optional<std::string>& volumeUuid,
        bool* _aidl_return);

// Map from UID to cache quota size
std::unordered_map<uid_t, int64_t> mCacheQuotas;
```

### 12.7.10 批量操作

为了批量操作（例如在创建用户后为所有应用创建数据目录）期间的性能，`installd` 支持批量变体：

```cpp
binder::Status createAppDataBatched(
    const std::vector<android::os::CreateAppDataArgs>& args,
    std::vector<android::os::CreateAppDataResult>* _aidl_return);
```

批量 API 通过在单个 IPC 调用中处理多个操作减少 Binder 往返开销。

### 12.7.11 SDK Sandbox 数据

为 Privacy Sandbox，`installd` 管理 SDK sandbox 的隔离数据目录：

```cpp
binder::Status createSdkSandboxDataPackageDirectory(
    const std::optional<std::string>& uuid,
    const std::string& packageName,
    int32_t userId, int32_t appId, int32_t flags);
```

这些目录与主应用的数据目录隔离，防止 SDK 访问宿主应用的私有数据。

### 12.7.12 fs-verity 支持

现代 `installd` 支持用于 APK 完整性验证的 fs-verity。`createFsveritySetupAuthToken()` 和 `enableFsverity()` 方法允许 `PackageManagerService` 在已安装 APK 文件上启用基于 Merkle 树的完整性检查：

```cpp
binder::Status createFsveritySetupAuthToken(
    const android::os::ParcelFileDescriptor& authFd,
    int32_t uid,
    android::sp<IFsveritySetupAuthToken>* _aidl_return);

binder::Status enableFsverity(
    const android::sp<IFsveritySetupAuthToken>& authToken,
    const std::string& filePath,
    const std::string& packageName,
    int32_t* _aidl_return);
```

auth token 模式确保只有打开该文件的进程才能在其上启用 fs-verity，防止 TOCTOU（time-of-check-time-of-use）竞态。

### 12.7.13 并发控制

`installd` 使用细粒度锁允许对不同包进行并发操作：

```cpp
private:
    std::recursive_mutex mLock;
    std::unordered_map<userid_t, std::weak_ptr<std::shared_mutex>> mUserIdLock;
    std::unordered_map<std::string, std::weak_ptr<std::recursive_mutex>> mPackageNameLock;
```

对不同包的操作可以并行进行，而同一包上的操作被串行化。`mUserIdLock` 映射为每个用户 ID 提供共享锁，允许同一用户内不同包的多个包操作并发运行。

---

## 12.8 GPU 服务

GpuService 管理 GPU 相关功能，包括驱动统计、内存跟踪、工作负载监控和游戏驱动管理。

### 12.8.1 源码布局

源码在 `frameworks/native/services/gpuservice/`：

| 目录 | 用途 |
|-----------|---------|
| `gpustats/` | GPU 驱动加载统计 |
| `gpumem/` | 通过 eBPF 的每进程 GPU 内存跟踪 |
| `gpuwork/` | 通过 eBPF 的 GPU 工作负载跟踪 |
| `tracing/` | 基于 Perfetto 的 GPU 内存追踪 |
| `feature_override/` | ANGLE 功能覆盖配置 |
| 根文件 | 主服务实现 |

### 12.8.2 服务实现

> `frameworks/native/services/gpuservice/include/gpuservice/GpuService.h`

```cpp
class GpuService : public BnGpuService, public PriorityDumper {
public:
    static const char* const SERVICE_NAME ANDROID_API;  // "gpu"

    GpuService() ANDROID_API;

private:
    // Components
    std::shared_ptr<GpuMem> mGpuMem;
    std::shared_ptr<gpuwork::GpuWork> mGpuWork;
    std::unique_ptr<GpuStats> mGpuStats;
    std::unique_ptr<GpuMemTracer> mGpuMemTracer;
    std::mutex mLock;
    std::string mDeveloperDriverPath;
    FeatureOverrideParser mFeatureOverrideParser;
};
```

### 12.8.3 子系统

**GpuStats**

跟踪每个应用的驱动加载统计，包括：

- 驱动包名和版本。
- GL、Vulkan 和 ANGLE 的加载成功/失败计数。
- 每应用加载时间。
- Vulkan 引擎名（用于游戏识别）。

来自 `frameworks/native/services/gpuservice/gpustats/GpuStats.cpp`：

```cpp
static void addLoadingCount(GpuStatsInfo::Driver driver, bool isDriverLoaded,
                            GpuStatsGlobalInfo* const outGlobalInfo) {
    switch (driver) {
        case GpuStatsInfo::Driver::GL:
        case GpuStatsInfo::Driver::GL_UPDATED:
            outGlobalInfo->glLoadingCount++;
            if (!isDriverLoaded) outGlobalInfo->glLoadingFailureCount++;
            break;
        case GpuStatsInfo::Driver::VULKAN:
        case GpuStatsInfo::Driver::VULKAN_UPDATED:
            outGlobalInfo->vkLoadingCount++;
            if (!isDriverLoaded) outGlobalInfo->vkLoadingFailureCount++;
            break;
        case GpuStatsInfo::Driver::ANGLE:
            outGlobalInfo->angleLoadingCount++;
            if (!isDriverLoaded) outGlobalInfo->angleLoadingFailureCount++;
            break;
        // ...
    }
}
```

这些数据上报给 statsd 用于遥测。

**GpuMem（GPU 内存跟踪）**

用 eBPF（extended Berkeley Packet Filter）程序跟踪每进程 GPU 内存分配。eBPF 程序附加到 GPU 驱动 tracepoint，维护一个可以从用户空间读取的 PID 到内存用量映射。

```mermaid
graph TB
    subgraph "内核"
        TP[GPU 驱动 Tracepoints]
        BPF[eBPF 程序]
        MAP["eBPF Map<br/>pid -> 内存"]
    end

    subgraph "GpuService"
        GM[GpuMem]
        GMT[GpuMemTracer]
    end

    TP --> BPF
    BPF --> MAP
    MAP --> GM
    GM --> GMT
    GMT -->|Perfetto| Trace[追踪文件]
```

**GpuWork（GPU 工作负载跟踪）**

与 GpuMem 类似，用 eBPF 跟踪每进程 GPU 工作负载，包括在 GPU 执行上花费的时间。BPF 程序头文件位于：

```
frameworks/native/services/gpuservice/gpuwork/bpfprogs/include/gpuwork/gpuWork.h
```

**ANGLE 集成**

GpuService 把 ANGLE（Almost Native Graphics Layer Engine）作为系统驱动管理。`toggleAngleAsSystemDriver()` 方法设置 `persist.graphics.egl` 属性：

```cpp
void GpuService::toggleAngleAsSystemDriver(bool enabled) {
    // Permission check: only system_server allowed
    if (multiuserappid != AID_SYSTEM ||
        !PermissionCache::checkPermission(sAccessGpuServicePermission, pid, uid)) {
        ALOGE("Permission Denial: can't set persist.graphics.egl");
        return;
    }

    if (enabled) {
        android::base::SetProperty("persist.graphics.egl", sAngleGlesDriverSuffix);
    } else {
        android::base::SetProperty("persist.graphics.egl", "");
    }
}
```

**功能覆盖解析器**

解析来自以下位置的 ANGLE 功能覆盖配置：

```cpp
const std::string kConfigFilePath =
    "/system/etc/angle/feature_config_vk.binarypb";
```

这允许 OEM 按应用或按设备覆盖特定 Vulkan/GLES 功能。

### 12.8.4 用于 GPU 监控的 eBPF 程序

GPU 服务使用 eBPF（extended Berkeley Packet Filter）程序进行内核级监控。eBPF 程序在内核内运行，可以高效跟踪事件，而没有每个事件的用户-内核转换开销。

**GPU 内存跟踪（GpuMem）**：

eBPF 程序附加到 GPU 驱动 tracepoint 并维护每进程内存映射：

```mermaid
graph TB
    subgraph "内核空间"
        TP[gpu_mem tracepoint]
        BPF_PROG["eBPF 程序：<br/>gpu_mem_total"]
        BPF_MAP["eBPF Map：<br/>gpu_mem_total_map<br/>key: (gpu_id << 32) | pid<br/>value: bytes"]
    end

    subgraph "用户空间"
        GM[GpuMem::initialize]
        READ[读取 eBPF map]
        DUMP[dumpsys gpu --gpumem]
    end

    TP -->|触发| BPF_PROG
    BPF_PROG -->|更新| BPF_MAP
    GM -->|附加程序| BPF_PROG
    READ -->|读取| BPF_MAP
    READ --> DUMP
```

`GpuMem::initialize()` 方法取回已固定在 `/sys/fs/bpf/` 下的 eBPF 程序，把它附加到 `gpu_mem/gpu_mem_total` tracepoint，并以只读方式（`BpfMapRO`）打开固定的 map。`GpuMemTracer` 注册一个 Perfetto 数据源，在追踪会话开始时把 map 的计数器转储到追踪中。

**GPU 工作跟踪（GpuWork）**：

类似地，GPU 工作跟踪器用 eBPF 监控每进程在 GPU 上执行所花费的时间。BPF 程序头文件：

```
frameworks/native/services/gpuservice/gpuwork/bpfprogs/include/gpuwork/gpuWork.h
```

这些数据用于：

- 功耗归因：确定哪个应用在消耗 GPU 功耗。
- 性能分析：识别 GPU 使用过度的应用。
- 调试：理解 GPU 调度行为。

两个 eBPF 程序都由受限 C 编译。`bpfloader` 在启动时把它们加载并固定到内核中。在服务启动时，GpuService 只是等待程序被加载（`waitForProgsLoaded()`）。然后它从 `/sys/fs/bpf/` 取回固定的程序并把它附加到其 tracepoint。它们以最小开销运行，因为它们在内核上下文中直接执行，避免上下文切换。

### 12.8.5 异步初始化

GpuService 异步初始化其 eBPF 子系统，避免延迟服务注册：

```cpp
GpuService::GpuService()
      : mGpuMem(std::make_shared<GpuMem>()),
        mGpuWork(std::make_shared<gpuwork::GpuWork>()),
        mGpuStats(std::make_unique<GpuStats>()),
        mGpuMemTracer(std::make_unique<GpuMemTracer>()),
        mFeatureOverrideParser(kConfigFilePath) {

    mGpuMemAsyncInitThread = std::make_unique<std::thread>([this]() {
        mGpuMem->initialize();
        mGpuMemTracer->initialize(mGpuMem);
    });

    mGpuWorkAsyncInitThread = std::make_unique<std::thread>([this]() {
        mGpuWork->initialize();
    });
};
```

eBPF 程序加载和 map 创建发生在专用线程上，让 GpuService 可以立即开始接受 Binder 调用。析构函数 join 两个线程以确保干净关闭：

```cpp
GpuService::~GpuService() {
    mGpuMem->stop();
    mGpuWork->stop();
    mGpuWorkAsyncInitThread->join();
    mGpuMemAsyncInitThread->join();
}
```

### 12.8.6 游戏驱动支持

Android 通过 Game Driver 机制支持可更新的 GPU 驱动。GpuService 跟踪两个驱动槽位：

```cpp
void dumpGameDriverInfo(std::string* result) {
    char stableGameDriver[PROPERTY_VALUE_MAX] = {};
    property_get("ro.gfx.driver.0", stableGameDriver, "unsupported");
    StringAppendF(result, "Stable Game Driver: %s\n", stableGameDriver);

    char preReleaseGameDriver[PROPERTY_VALUE_MAX] = {};
    property_get("ro.gfx.driver.1", preReleaseGameDriver, "unsupported");
    StringAppendF(result, "Pre-release Game Driver: %s\n", preReleaseGameDriver);
}
```

`setUpdatableDriverPath()` 方法允许 `system_server` 为开发目的指定替代驱动路径。

### 12.8.7 Shell 命令

GpuService 通过 `adb shell cmd gpu` 支持 shell 命令：

| 命令 | 用途 |
|---------|---------|
| `vkjson` | 以 JSON 转储 Vulkan 设备属性 |
| `vkprofiles` | 打印对 Vulkan profile 的支持 |
| `featureOverrides` | 显示 ANGLE 功能覆盖 |

---

## 12.9 传感器服务

SensorService 管理对所有硬件和虚拟传感器的访问——加速度计、陀螺仪、磁力计、气压计、接近传感器以及其他许多传感器。

### 12.9.1 源码布局

源码在 `frameworks/native/services/sensorservice/`：

| 文件 | 用途 |
|------|---------|
| `SensorService.h` / `.cpp` | 主服务实现 |
| `SensorDevice.h` / `.cpp` | HAL 抽象（单例） |
| `SensorEventConnection.cpp` | 每客户端连接处理 |
| `SensorDirectConnection.h` | 直接传感器通道（低延迟） |
| `ISensorHalWrapper.h` | HAL 包装接口 |
| `AidlSensorHalWrapper.h` | AIDL HAL 实现 |
| `SensorFusion.cpp` | 软件传感器融合 |
| `RotationVectorSensor.cpp` | 计算的旋转矢量 |
| `CorrectedGyroSensor.cpp` | 偏置校正陀螺仪 |
| `OrientationSensor.cpp` | 计算的方向 |
| `LimitedAxesImuSensor.h` | 有限轴 IMU 传感器 |
| `SensorInterface.h` / `.cpp` | 抽象传感器接口 |
| `SensorRecord.h` | 每传感器激活跟踪 |
| `RecentEventLogger.h` | 最近事件历史 |
| `BatteryService.h` | 传感器的电池使用跟踪 |

### 12.9.2 架构

```mermaid
graph TB
    subgraph "应用"
        SM1["SensorManager<br/>App 1"]
        SM2["SensorManager<br/>App 2"]
    end

    subgraph "SensorService"
        SS["SensorService<br/>线程"]
        SEC["SensorEventConnection<br/>每客户端"]
        SDC["SensorDirectConnection<br/>低延迟"]
        SD["SensorDevice<br/>单例"]
        SF[SensorFusion]
        VS["虚拟传感器<br/>RotationVector 等"]
    end

    subgraph "HAL"
        HW[ISensorHalWrapper]
        AIDL[AidlSensorHalWrapper]
        HIDL[HidlSensorHalWrapper]
    end

    SM1 --> SEC
    SM2 --> SEC
    SM1 --> SDC
    SEC --> SS
    SDC --> SD
    SS --> SD
    SD --> HW
    HW --> AIDL
    HW --> HIDL
    SS --> SF
    SF --> VS
```

### 12.9.3 服务启动

SensorService 使用 `BinderService` 模板进行注册：

> `frameworks/native/services/sensorservice/main_sensorservice.cpp`

```cpp
int main(int /*argc*/, char** /*argv*/) {
    signal(SIGPIPE, SIG_IGN);
    SensorService::publishAndJoinThreadPool();
    return 0;
}
```

`SensorService` 类继承自三个基类：

```cpp
class SensorService :
        public BinderService<SensorService>,
        public BnSensorServer,
        protected Thread
{
```

- **`BinderService<SensorService>`**：处理向 servicemanager 的注册。
- **`BnSensorServer`**：`ISensorServer` 的 Binder 原生实现。
- **`Thread`**：SensorService 运行自己的轮询线程。

### 12.9.4 SensorDevice 单例

`SensorDevice` 是与传感器 HAL 接口的单例：

> `frameworks/native/services/sensorservice/SensorDevice.cpp`

```cpp
ANDROID_SINGLETON_STATIC_INSTANCE(SensorDevice)

SensorDevice::SensorDevice() : mInHalBypassMode(false) {
    if (!connectHalService()) {
        return;
    }
    initializeSensorList();
    mIsDirectReportSupported =
        (mHalWrapper->unregisterDirectChannel(-1) != INVALID_OPERATION);
}
```

HAL 包装接口（`ISensorHalWrapper`）同时抽象 AIDL 和 HIDL HAL 版本：

```cpp
class ISensorHalWrapper {
public:
    enum HalConnectionStatus {
        CONNECTED,
        DOES_NOT_EXIST,
        FAILED_TO_CONNECT,
        UNKNOWN,
    };

    virtual bool connect(SensorDeviceCallback *callback) = 0;
    virtual ssize_t poll(sensors_event_t *buffer, size_t count) = 0;
    virtual ssize_t pollFmq(sensors_event_t *buffer,
                            size_t maxNumEventsToRead) = 0;
    virtual std::vector<sensor_t> getSensorsList() = 0;
    virtual status_t activate(int32_t sensorHandle, bool enabled) = 0;
    virtual status_t batch(int32_t sensorHandle, int64_t samplingPeriodNs,
                           int64_t maxReportLatencyNs) = 0;
    virtual status_t flush(int32_t sensorHandle) = 0;
    // ...
};
```

包装器支持两种轮询模式：

- **传统轮询**（`poll()`）：阻塞调用，事件可用时返回。
- **快速消息队列**（`pollFmq()`）：用共享内存 FIFO 实现更低延迟的事件交付（HAL 2.0+）。

### 12.9.5 传感器融合与虚拟传感器

SensorService 创建几个不对应物理硬件的**虚拟传感器**。它们用传感器融合算法从物理传感器数据计算而来：

来自 `frameworks/native/services/sensorservice/RotationVectorSensor.cpp`：

```cpp
RotationVectorSensor::RotationVectorSensor(int mode) : mMode(mode) {
    const sensor_t sensor = {
        .name       = getSensorName(),
        .vendor     = "AOSP",
        .version    = 3,
        .handle     = getSensorToken(),
        .type       = getSensorType(),
        .maxRange   = 1,
        .resolution = 1.0f / (1<<24),
        .power      = mSensorFusion.getPowerUsage(),
        .minDelay   = mSensorFusion.getMinDelay(),
    };
    mSensor = Sensor(&sensor);
}
```

融合模式产生不同的旋转矢量：

| 模式 | 传感器类型 | 输入传感器 |
|------|-------------|---------------|
| `FUSION_9AXIS` | `ROTATION_VECTOR` | 加速度计 + 陀螺仪 + 磁力计 |
| `FUSION_NOMAG` | `GAME_ROTATION_VECTOR` | 加速度计 + 陀螺仪 |
| `FUSION_NOGYRO` | `GEOMAGNETIC_ROTATION_VECTOR` | 加速度计 + 磁力计 |

`GyroDriftSensor` 从传感器融合算法计算陀螺仪偏置估计，让其他组件可以校正陀螺仪漂移。

### 12.9.6 客户端连接模型

每个注册传感器事件的客户端获得一个 `SensorEventConnection`：

```cpp
SensorService::SensorEventConnection::SensorEventConnection(
        const sp<SensorService>& service, uid_t uid, pid_t pid,
        String8 packageName, bool isDataInjectionMode,
        const String16& opPackageName, const String16& attributionTag)
    : mService(service), mUid(uid), mPid(pid), mWakeLockRefCount(0),
      mHasLooperCallbacks(false), mDead(false),
      mDataInjectionMode(isDataInjectionMode), mEventCache(nullptr),
      mCacheSize(0), mMaxCacheSize(0), /* ... */ {
    mUserId = multiuser_get_user_id(mUid);
    mChannel = new BitTube(mService->mSocketBufferSize);
}
```

事件通过 **BitTube** 对象交付——为批量事件交付优化的底层 socket 对。socket 缓冲区大小可配置：

```cpp
#define MAX_SOCKET_BUFFER_SIZE_BATCHED (100 * 1024)    // 100 KB
#define SOCKET_BUFFER_SIZE_NON_BATCHED (4 * 1024)      // 4 KB
```

### 12.9.7 速率限制与隐私

为隐私保护，SensorService 对面向 Android 12+ 且缺少 `HIGH_SAMPLING_RATE_SENSORS` 权限的应用限制采样率：

```cpp
// Capped at 200 Hz
#define SENSOR_SERVICE_CAPPED_SAMPLING_PERIOD_NS (5 * 1000 * 1000)
// Direct channel rate capped to NORMAL (<=110 Hz)
#define SENSOR_SERVICE_CAPPED_SAMPLING_RATE_LEVEL SENSOR_DIRECT_RATE_NORMAL
```

这防止应用用高频传感器数据进行侧信道攻击（例如从加速度计数据推断屏幕点击）。

### 12.9.8 SensorService 轮询循环

SensorService 继承自 `Thread` 并运行连续轮询循环：

```mermaid
graph TB
    subgraph "SensorService 线程循环"
        A[threadLoop 开始]
        B["SensorDevice::poll<br/>阻塞直到事件可用"]
        C{收到事件？}
        D[处理物理传感器事件]
        E[馈送给 SensorFusion]
        F[生成虚拟传感器事件]
        G["分发给所有<br/>SensorEventConnection"]
        H[写入 BitTube socket]
        I[跟踪电池使用]
    end

    A --> B
    B --> C
    C -->|是| D
    C -->|无事件 / 错误| B
    D --> E
    E --> F
    F --> G
    G --> H
    H --> I
    I --> B
```

该循环为效率而设计：

1. `poll()` 在内核中阻塞直到传感器事件可用，使用传统阻塞读或快速消息队列（FMQ）。
2. 事件被批处理——HAL 可以在单次 poll 返回中交付多达数百个事件。
3. 虚拟传感器处理（融合）与物理事件处理内联进行，增加最小延迟。
4. 向客户端的分发是批量的——单个 poll 周期的所有事件一起写入客户端 socket。

基于 FMQ 的轮询（`pollFmq()`）对 HAL 2.0+ 是首选，因为它避免每个轮询周期一次 Binder/HIDL 调用的开销。FMQ 是 SensorService 与 HAL 之间的共享内存环形缓冲区，使用 eventfd 或 futex 的轻量级信令机制。

### 12.9.9 动态传感器支持

SensorService 支持动态传感器——可以在运行时连接和断开的传感器（例如 USB 传感器、蓝牙传感器）：

```cpp
class ISensorHalWrapper {
public:
    class SensorDeviceCallback {
    public:
        virtual void onDynamicSensorsConnected(
            const std::vector<sensor_t>& dynamicSensorsAdded) = 0;
        virtual void onDynamicSensorsDisconnected(
            const std::vector<int32_t>& dynamicSensorHandlesRemoved) = 0;
    };
};
```

当动态传感器连接时：

1. HAL 通过回调通知 SensorDevice。
2. SensorDevice 把新传感器添加到其内部列表。
3. SensorService 为动态传感器创建新的 `SensorInterface`。
4. 注册了动态传感器通知的客户端被告知。

### 12.9.10 工作模式

SensorService 支持多种工作模式：

```cpp
enum Mode {
    NORMAL = 0,         // Regular operation
    DATA_INJECTION = 1, // HAL accepts injected data (testing)
    RESTRICTED = 2,     // Only allowlisted apps can access sensors
    // ...
};
```

`DATA_INJECTION` 模式被 CTS 测试用于提供已知传感器值。`RESTRICTED` 模式只允许白名单应用（通常是 CTS）访问传感器，禁用所有其他连接。

### 12.9.11 直接传感器通道

为实现超低延迟传感器交付，SensorService 支持**直接通道**。事件不经过基于 socket 的 `SensorEventConnection`，而是直接写入应用映射的共享内存区域：

```
SensorHAL -> Shared Memory (GRALLOC/ashmem) -> Application
```

这绕过了所有 SensorService 处理，为 VR 等需要即时传感器数据的应用实现尽可能低的延迟。

---

## 12.10 servicemanager 与 dumpsys

### 12.10.1 servicemanager：基础

`servicemanager` 是 `init` 在 `core` 类中启动的第一批服务之一（在 `ueventd` 和 `logd` 等早期服务之后）。它是 Android 服务基础设施的基石。其他每个服务——原生和 Java——都依赖它进行注册和发现。

**源码位置**：`frameworks/native/cmds/servicemanager/`

| 文件 | 用途 |
|------|---------|
| `main.cpp` | 入口点、Binder 设置、事件循环 |
| `ServiceManager.h` / `.cpp` | 核心服务注册表 |
| `Access.h` / `.cpp` | SELinux 权限检查 |
| `NameUtil.h` | 服务名解析工具 |

### 12.10.2 servicemanager 启动

`main.cpp` 中的启动序列是 Binder 架构的大师课：

> `frameworks/native/cmds/servicemanager/main.cpp`

```cpp
int main(int argc, char** argv) {
    android::base::InitLogging(argv, android::base::KernelLogger);

    const char* driver = argc == 2 ? argv[1] : "/dev/binder";

    sp<ProcessState> ps = ProcessState::initWithDriver(driver);
    ps->setThreadPoolMaxThreadCount(0);
    ps->setCallRestriction(ProcessState::CallRestriction::FATAL_IF_NOT_ONEWAY);

    IPCThreadState::self()->disableBackgroundScheduling(true);

    sp<ServiceManager> manager =
        sp<ServiceManager>::make(std::make_unique<Access>());
    manager->setRequestingSid(true);

    if (!manager->addService("manager", manager, false,
            IServiceManager::DUMP_FLAG_PRIORITY_DEFAULT).isOk()) {
        LOG(ERROR) << "Could not self register servicemanager";
    }

    IPCThreadState::self()->setTheContextObject(manager);
    if (!ps->becomeContextManager()) {
        LOG(FATAL) << "Could not become context manager";
    }

    sp<Looper> looper = Looper::prepare(false);
    sp<BinderCallback> binderCallback = BinderCallback::setupTo(looper);
    ClientCallbackCallback::setupTo(looper, manager, binderCallback);

    if (!SetProperty("servicemanager.ready", "true")) {
        LOG(ERROR) << "Failed to set servicemanager ready property";
    }

    while(true) {
        looper->pollAll(-1);
    }

    return EXIT_FAILURE;
}
```

关键初始化步骤：

1. **`ProcessState::initWithDriver("/dev/binder")`**：打开 Binder 驱动。对于 vendor servicemanager，这将是 `/dev/vndbinder`。

2. **`setThreadPoolMaxThreadCount(0)`**：servicemanager 使用单线程 Looper 模型，而不是线程池。所有 Binder 调用在主线程上顺序处理。

3. **`setCallRestriction(FATAL_IF_NOT_ONEWAY)`**：由于 servicemanager 在单线程上处理所有调用，允许同步（双向）调用其他服务会带来死锁风险。此限制确保 servicemanager 只进行单向调用。

4. **`becomeContextManager()`**：这个特殊 Binder ioctl（`BINDER_SET_CONTEXT_MGR`）使该进程成为默认 Binder context manager。任何到 handle 0（"null"句柄）的 Binder 事务都被路由到此进程。这就是 `defaultServiceManager()` 的工作方式——它返回 handle 0 的代理。

5. **自注册**：servicemanager 把自己注册为 `"manager"`，使它通过与所有其他服务相同的机制可被发现。

6. **基于 Looper 的事件循环**：servicemanager 不用 `joinThreadPool()`，而是用带基于回调的 FD 监控的 `Looper`。这允许它也处理用于客户端回调管理的定时器事件。

### 12.10.3 服务注册表

`ServiceManager` 类维护三个关键数据结构：

```cpp
ServiceMap mNameToService;                     // name -> Service
ServiceCallbackMap mNameToRegistrationCallback; // name -> callbacks
ClientCallbackMap mNameToClientCallback;        // name -> client callbacks
```

`Service` 结构存储已注册服务的所有信息：

```cpp
struct Service {
    sp<IBinder> binder;       // not null
    bool allowIsolated;       // Accessible from isolated processes?
    int32_t dumpPriority;     // CRITICAL, HIGH, NORMAL, DEFAULT
    bool hasClients = false;  // Client notification state
    bool guaranteeClient = false;
    Access::CallingContext ctx; // Who registered this service
};
```

### 12.10.4 SELinux 访问控制

servicemanager 上的每个操作都受 SELinux 策略强制约束。`Access` 类包装 SELinux 检查：

> `frameworks/native/cmds/servicemanager/Access.cpp`

```cpp
bool Access::canFind(const CallingContext& ctx, const std::string& name) {
    return actionAllowedFromLookup(ctx, name, "find");
}

bool Access::canAdd(const CallingContext& ctx, const std::string& name) {
    return actionAllowedFromLookup(ctx, name, "add");
}

bool Access::canList(const CallingContext& ctx) {
    return actionAllowed(ctx, mThisProcessContext, "list", "service_manager");
}
```

实现从 `service_contexts` 文件查找服务的 SELinux context，然后执行权限检查：

```cpp
bool Access::actionAllowedFromLookup(const CallingContext& sctx,
        const std::string& name, const char *perm) {
    char *tctx = nullptr;
    if (selabel_lookup(getSehandle(), &tctx, name.c_str(),
                       SELABEL_CTX_ANDROID_SERVICE) != 0) {
        LOG(ERROR) << "SELinux: No match for " << name
                   << " in service_contexts.";
        return false;
    }
    bool allowed = actionAllowed(sctx, tctx, perm, name);
    freecon(tctx);
    return allowed;
}
```

这是防止任意应用注册为系统服务或查找它们不应访问的服务的机制。例如，不受信任的应用进程无法查找 `"installd"`，因为它的 SELinux 域对该服务的 context 没有 `find` 权限。

调用 context 从 Binder 事务中提取：

```cpp
Access::CallingContext Access::getCallingContext() {
    IPCThreadState* ipc = IPCThreadState::self();
    const char* callingSid = ipc->getCallingSid();
    pid_t callingPid = ipc->getCallingPid();

    return CallingContext {
        .debugPid = callingPid,
        .uid = ipc->getCallingUid(),
        .sid = callingSid ? std::string(callingSid)
                          : getPidcon(callingPid),
    };
}
```

### 12.10.5 服务注册流程

当服务调用 `addService()` 时，发生以下事情：

```mermaid
sequenceDiagram
    participant Svc as 新服务
    participant SM as ServiceManager
    participant SEL as SELinux
    participant CB as 已注册回调

    Svc->>SM: addService("name", binder, allowIsolated, priority)
    SM->>SM: getCallingContext()
    SM->>SEL: canAdd(ctx, "name")
    SEL->>SEL: selabel_lookup + selinux_check_access
    SEL-->>SM: allowed = true
    SM->>SM: mNameToService["name"] = Service{binder, ...}
    SM->>SM: binder->linkToDeath(this)
    SM->>CB: 通知所有 mNameToRegistrationCallback["name"]
    SM-->>Svc: Status::ok()
```

`linkToDeath()` 调用确保如果服务进程死亡，servicemanager 收到死亡通知并从注册表中移除服务。通过 `registerForNotifications()` 注册了回调的客户端在服务出现或消失时被通知。

### 12.10.6 getService 与 addService 流程

让我们走读注册和发现两者的完整代码路径。

**addService 流程**：

当服务调用 `sm->addService("SurfaceFlinger", binder, ...)` 时，servicemanager 内部执行以下代码路径：

```cpp
// ServiceManager.cpp (simplified)
binder::Status ServiceManager::addService(
        const std::string& name, const sp<IBinder>& binder,
        bool allowIsolated, int32_t dumpPriority) {
    auto ctx = mAccess->getCallingContext();

    // 1. Validate the service name
    std::optional<std::string> accessor;
    auto status = canAddService(ctx, name, &accessor);
    if (!status.isOk()) return status;

    // 2. VINTF declaration check (meetsDeclarationRequirements):
    // binders marked as requiring VINTF stability must be declared
    // in the VINTF manifest

    // 3. Store in the service map
    mNameToService[name] = Service {
        .binder = binder,
        .allowIsolated = allowIsolated,
        .dumpPriority = dumpPriority,
        .ctx = ctx,
    };

    // 4. Register for death notifications
    binder->linkToDeath(sp<ServiceManager>::fromExisting(this));

    // 5. Notify waiting clients
    auto it = mNameToRegistrationCallback.find(name);
    if (it != mNameToRegistrationCallback.end()) {
        for (const auto& cb : it->second) {
            cb->onRegistration(name, binder);
        }
    }

    return Status::ok();
}
```

**getService 流程**：

当客户端调用 `sm->getService("SurfaceFlinger")` 时：

```cpp
// ServiceManager.cpp (simplified)
binder::Status ServiceManager::getService(
        const std::string& name, sp<IBinder>* outBinder) {
    *outBinder = tryGetBinder(name, true /* startIfNotFound */).service;
    return Status::ok();
}

os::ServiceWithMetadata ServiceManager::tryGetBinder(
        const std::string& name, bool startIfNotFound) {
    auto ctx = mAccess->getCallingContext();

    // 1. SELinux permission check
    std::optional<std::string> accessor;
    if (!canFindService(ctx, name, &accessor).isOk()) {
        return {};
    }

    // 2. Look up in the service map
    auto it = mNameToService.find(name);
    if (it != mNameToService.end()) {
        return it->second;
    }

    // 3. If not found and startIfNotFound, try to start it
    if (startIfNotFound) {
        tryStartService(ctx, name);
    }

    return {};
}
```

`tryStartService()` 方法设置一个触发 `init` 启动服务的系统属性（`ctl.interface_start`）：

```cpp
void ServiceManager::tryStartService(
        const Access::CallingContext& ctx,
        const std::string& name) {
    // ... property-based service start
    android::base::SetProperty("ctl.interface_start",
                               "aidl/" + name);
}
```

这就是"懒服务"机制：HAL 服务只在首次被请求时才启动，减少启动时间和内存占用。

### 12.10.7 VINTF 集成

对非 vendor servicemanager，`isDeclared()` 方法检查服务是否在 VINTF（Vendor Interface）清单中声明：

```cpp
binder::Status ServiceManager::isDeclared(const std::string& name,
                                          bool* outReturn) {
    // ... checks VINTF manifest for the service name
}
```

这在启动期间用于验证所有必需的 HAL 服务都已声明并最终会被注册。`getDeclaredInstances()` 方法返回特定 HAL 接口的所有已声明实例。

### 12.10.8 客户端回调机制

servicemanager 为服务提供一个通知机制来跟踪它们是否有活跃客户端：

```cpp
binder::Status registerClientCallback(const std::string& name,
                                      const sp<IBinder>& service,
                                      const sp<IClientCallback>& cb);
```

一个定时器每 5 秒触发检查客户端引用计数：

```cpp
// From main.cpp
itimerspec timespec {
    .it_interval = { .tv_sec = 5, .tv_nsec = 0, },
    .it_value = { .tv_sec = 5, .tv_nsec = 0, },
};
```

当引用计数降到零（没有更多客户端）时，回调通知服务。服务随后可以决定停止或进入空闲状态。

### 12.10.9 tryUnregisterService 方法

服务可以自愿注销自己。这用于服务确定不再需要时：

```cpp
binder::Status tryUnregisterService(const std::string& name,
                                     const sp<IBinder>& binder);
```

该方法只在以下条件满足时成功：

1. 调用者与注册服务的进程相同。
2. 服务没有剩余客户端（或 `hasClients` 标志表明所有客户端都已被通知）。

这是"懒服务"模式的一部分：HAL 服务在首次请求时启动，服务客户端，然后在所有客户端断开时注销。服务进程随后可以退出，释放内存和 CPU 资源。

### 12.10.10 服务调试信息

`getServiceDebugInfo()` 方法返回所有已注册服务的详细信息：

```cpp
binder::Status getServiceDebugInfo(
    std::vector<ServiceDebugInfo>* outReturn);
```

每个 `ServiceDebugInfo` 条目恰好包含两个字段：

- 服务名
- `debugPid`——注册时宿主进程的 PID（可能已不再有效）

此信息被系统监控工具和 `bugreport` 用于提供服务生态的快照。

### 12.10.11 Perfetto 追踪集成

系统 servicemanager（但不是 vendor servicemanager）与 Perfetto 集成以追踪服务注册和查找事件：

```cpp
#if !defined(VENDORSERVICEMANAGER) && !defined(__ANDROID_RECOVERY__)
#define PERFETTO_SM_CATEGORIES(C) \
    C(servicemanager, "servicemanager", "Service Manager category")
PERFETTO_TE_CATEGORIES_DECLARE(PERFETTO_SM_CATEGORIES);
#endif
```

开发者可以在 Perfetto 追踪中看到服务注册和查找事件。这有助于诊断启动性能问题。例如，一个服务可能因为其依赖的 HAL 注册缓慢而耗时过长。

### 12.10.12 dumpsys：诊断瑞士军刀

`dumpsys` 是查询系统服务状态的命令行工具。它位于 `frameworks/native/cmds/dumpsys/`。

**用法**：

```bash
# Dump all services
adb shell dumpsys

# Dump a specific service
adb shell dumpsys SurfaceFlinger

# List all registered services
adb shell dumpsys -l

# Dump with priority filter
adb shell dumpsys --priority CRITICAL

# Dump with timeout
adb shell dumpsys -t 30 SurfaceFlinger

# Dump PID of service host process
adb shell dumpsys --pid SurfaceFlinger

# Dump thread usage
adb shell dumpsys --thread SurfaceFlinger

# Dump client PIDs
adb shell dumpsys --clients SurfaceFlinger

# Dump binder stability info
adb shell dumpsys --stability SurfaceFlinger

# Skip certain services
adb shell dumpsys --skip SurfaceFlinger,input
```

### 12.10.13 dumpsys 实现

`Dumpsys` 类包装 `IServiceManager` 接口：

> `frameworks/native/cmds/dumpsys/dumpsys.h`

```cpp
class Dumpsys {
public:
    explicit Dumpsys(android::IServiceManager* sm) : sm_(sm) {}

    int main(int argc, char* const argv[]);

    enum Type {
        TYPE_DUMP = 0x1,
        TYPE_PID = 0x2,
        TYPE_STABILITY = 0x4,
        TYPE_THREAD = 0x8,
        TYPE_CLIENTS = 0x10,
    };

    // ...
};
```

转储机制的工作方式：

1. 调用 `sm_->listServices()` 获取所有已注册服务。
2. 对每个服务，调用 `sm_->checkService()` 获取 `IBinder`。
3. 派生一个线程调用服务上的 `service->dump(fd, args)`。
4. 从管道读取输出，带可配置超时（默认 10s）。
5. 把输出写到 stdout，带分段标题和时序信息。

带超时的线程化转储至关重要，因为 `dump()` 调用进入服务的进程，可能挂起：

```cpp
status_t Dumpsys::startDumpThread(int dumpTypeFlags,
        const String16& serviceName, const Vector<String16>& args,
        ServiceBehavior serviceBehavior) {
    sp<IBinder> service;
    if (serviceBehavior == ServiceBehavior::WAIT_UNTIL_STARTED) {
        service = sm_->waitForService(serviceName);  // the -w flag (12.11.5)
    } else {
        service = sm_->checkService(serviceName);
    }
    if (service == nullptr) {
        std::cerr << "Can't find service: " << serviceName << std::endl;
        return NAME_NOT_FOUND;
    }

    int sfd[2];
    if (pipe(sfd) != 0) { /* error handling */ }

    redirectFd_ = unique_fd(sfd[0]);
    unique_fd remote_end(sfd[1]);

    // dump blocks until completion, so spawn a thread..
    activeThread_ = std::thread([=, remote_end{std::move(remote_end)}]() mutable {
        // ... other dump types (PID, stability, threads, clients) run
        // first, acting as a header for the main dump output
        if (dumpTypeFlags & TYPE_DUMP) {
            status_t err = service->dump(remote_end.get(), args);
            reportDumpError(serviceName, err, "dumping");
        }
    });
    return OK;
}
```

### 12.10.14 基于优先级的转储

服务在调用 `addService()` 时注册转储优先级：

```cpp
sm->addService(name, binder, allowIsolated, dumpPriority);
```

优先级级别：

| 优先级 | 标志 | 用途 |
|----------|------|-----|
| `DUMP_FLAG_PRIORITY_CRITICAL` | 关键系统状态 | bug 报告中排第一 |
| `DUMP_FLAG_PRIORITY_HIGH` | 重要但不关键 | 报告中排第二 |
| `DUMP_FLAG_PRIORITY_NORMAL` | 标准服务 | 转储输出主体 |
| `DUMP_FLAG_PRIORITY_DEFAULT` | 未指定优先级 | 与 NORMAL 相同 |

`PriorityDumper` 辅助类（被 SurfaceFlinger、GpuService 等使用）根据优先级参数把转储请求路由到适当的处理器：

```cpp
status_t dumpCritical(int fd, const Vector<String16>& args, bool asProto);
status_t dumpHigh(int fd, const Vector<String16>& args, bool asProto);
status_t dumpNormal(int fd, const Vector<String16>& args, bool asProto);
status_t dumpAll(int fd, const Vector<String16>& args, bool asProto);
```

这允许 `bugreport` 等工具先收集关键信息（在超时之前），然后再收集不太关键的信息。

### 12.10.15 dumpsys 超时机制

超时处理值得特别注意，因为如果服务死锁，服务转储可能挂起：

```cpp
status_t Dumpsys::writeDump(int fd, const String16& serviceName,
        std::chrono::milliseconds timeout, bool asProto,
        std::chrono::duration<double>& elapsedDuration,
        size_t& bytesWritten) const {
    // ...
    struct pollfd pfd = {.fd = serviceDumpFd, .events = POLLIN};

    while (true) {
        auto time_left_ms = [end]() {
            auto now = std::chrono::steady_clock::now();
            auto diff = std::chrono::duration_cast<
                std::chrono::milliseconds>(end - now);
            return std::max(diff.count(), 0LL);
        };

        int rc = TEMP_FAILURE_RETRY(poll(&pfd, 1, time_left_ms()));
        if (rc == 0 || time_left_ms() == 0) {
            status = TIMED_OUT;
            break;
        }

        char buf[4096];
        rc = TEMP_FAILURE_RETRY(read(redirectFd_.get(), buf, sizeof(buf)));
        // ... write to output
    }
}
```

机制的工作方式：

1. 转储在写入管道一端的单独线程中运行。
2. 主线程用 `poll()` 从管道另一端读取。
3. 如果 `poll()` 超时（默认 10 秒），转储被放弃。
4. 转储线程被 detach（不 join）以避免无限期阻塞。

超时发生时，dumpsys 打印：

```
*** SERVICE 'SurfaceFlinger' DUMP TIMEOUT (10000ms) EXPIRED ***
```

这防止挂起的服务阻塞整个 `bugreport` 收集。

### 12.10.16 dumpsys 额外转储类型

除了标准 `dump()` 调用，dumpsys 可以提取其他信息：

```cpp
enum Type {
    TYPE_DUMP = 0x1,       // Call service->dump()
    TYPE_PID = 0x2,        // Get host process PID
    TYPE_STABILITY = 0x4,  // Binder stability information
    TYPE_THREAD = 0x8,     // Thread pool usage
    TYPE_CLIENTS = 0x10,   // Client process PIDs
};
```

**线程转储**对诊断线程池耗尽特别有用：

```cpp
static status_t dumpThreadsToFd(const sp<IBinder>& service,
                                 const unique_fd& fd) {
    pid_t pid;
    service->getDebugPid(&pid);
    BinderPidInfo pidInfo;
    getBinderPidInfo(BinderDebugContext::BINDER, pid, &pidInfo);
    WriteStringToFd("Threads in use: " +
        std::to_string(pidInfo.threadUsage) + "/" +
        std::to_string(pidInfo.threadCount) + "\n", fd.get());
    return OK;
}
```

**客户端转储**显示哪些进程连接到服务：

```cpp
static status_t dumpClientsToFd(const sp<IBinder>& service,
                                 const unique_fd& fd) {
    // ... uses Binder debug interface to find client PIDs
    WriteStringToFd("Client PIDs: " +
        ::android::base::Join(pids, ", ") + "\n", fd.get());
    return OK;
}
```

### 12.10.17 服务名约定

通用服务名验证由 `ServiceManager.cpp` 中的 `isValidServiceName()` 完成。另外，`NameUtil.h` 提供一个 `NativeName` 解析器，用于 `{package}/{instance}` 形式的**原生**（非 AIDL）VINTF 实例名。package 部分不能包含点。`hasNativeInstance()` VINTF 查找使用此解析器：

> `frameworks/native/cmds/servicemanager/NameUtil.h`

```cpp
struct NativeName {
    std::string package;
    std::string instance;

    // Parse {package}/{instance}
    static bool fill(std::string_view name, NativeName* nname) {
        size_t slash = name.find('/');
        if (slash == std::string_view::npos) return false;
        if (name.find('/', slash + 1) != std::string_view::npos) return false;
        if (slash == 0 || slash + 1 == name.size()) return false;
        if (name.rfind('.', slash) != std::string_view::npos) return false;
        nname->package = name.substr(0, slash);
        nname->instance = name.substr(slash + 1);
        return true;
    }
};
```

类似 `mapper/default` 的原生 HAL 实例名解析为 `NativeName`。注意，上面的 `rfind('.', slash)` 检查明确拒绝 `android.hardware.sensors.ISensors/default` 这样的带点 AIDL 风格名。Framework 服务使用简单名（例如 `SurfaceFlinger`、`installd`、`gpu`）。

---

## 12.11 Android 17 中的原生服务

原生服务架构已经很成熟，所以 Android 17 的大部分变化是对既有服务的增量完善，而不是新的顶层服务。本节收集落在上述服务中的变化。每一项都以针对 `android-16.0.0_r4` 基线的 diff 为依据，所以这里的一切都是 17 相对 16 的新内容。

### 12.11.1 installd：Private Compute Core 数据目录

本章各仓库中最大的单个变化是 `installd` 获得对**Private Compute Core（PCC）**数据目录的原生支持。PCC 是承载隐私敏感推理的隔离、设备端计算环境（与 Android Private Compute Core / AICore 栈同族）。在 17 中，`PackageManagerService` 可以请 `installd` 为包预配第二套隔离数据目录，与包的正常应用数据不同。

这些目录复用包名并带固定后缀：

> `frameworks/native/cmds/installd/installd_constants.h`

```cpp
constexpr const char* kPccDataSuffix = "-pcc";
```

所以包 `com.example.app` 获得诸如 `/data/user/{userId}/com.example.app-pcc/`（CE）和 `/data/user_de/{userId}/com.example.app-pcc/`（DE）的 PCC 目录。单独的 PCC UID 拥有它们。`PackageManagerService` 提供 PCC app id，UID 由它派生。PCC 目录遵循与普通应用数据相同的 CE/DE 拆分（12.7.5）。所以隐私敏感状态可以按需设备加密（Direct Boot 可用）或凭据加密。

`IInstalld` AIDL 接口被扩展以携带 PCC 身份。create/clear/destroy 操作现在把 PCC app id 和 inode 穿过它们的参数：

> `frameworks/native/cmds/installd/binder/android/os/CreateAppDataArgs.aidl`

```aidl
int pccId;
int previousPccId;
```

> `frameworks/native/cmds/installd/InstalldNativeService.h`

```cpp
binder::Status clearAppData(const std::optional<std::string>& uuid,
                            const std::string& packageName, int32_t userId, int32_t flags,
                            int64_t ceDataInode, int64_t pccCeDataInode);
binder::Status destroyAppData(const std::optional<std::string>& uuid,
                              const std::string& packageName, int32_t userId, int32_t flags,
                              int64_t ceDataInode, int64_t pccCeDataInode);
binder::Status destroyPccData(const std::optional<std::string>& uuid,
                              const std::string& packageName, int32_t userId, int32_t flags,
                              int64_t ceDataInode);
```

`InstalldNativeService.cpp` 实现中的行为：

- **`createAppData`** 在 `CreateAppDataArgs` 中提供有效 PCC app id（`pccId`）时创建 `{pkg}-pcc` 的 CE 和 DE 目录。installd 用 `multiuser_get_uid(userId, pccId)` 派生拥有 UID。如果 PCC app id 无效（包不再需要 PCC），installd 移除任何现有 `{pkg}-pcc` 目录。
- **`clearAppData`** 清除 `{pkg}-pcc` 目录的内容。
- **`destroyAppData`**（以及专门的 `destroyPccData`）删除它们。

整个功能由 `android.app.privatecompute.flags.enable_pcc_framework_support` aconfig 标志门控。

一对相关操作 `moveAppDataPath()` 和 `copyAppDataPath()` 被添加。它们在应用目录之间移动或拷贝数据。它们用于数据移入或移出 PCC 目录时：

> `frameworks/native/cmds/installd/InstalldNativeService.h`

```cpp
binder::Status copyAppDataPath(const std::optional<std::string>& uuid,
                               const std::string& fromPath, const std::string& toPath,
                               int32_t userId, int32_t appId, const std::string& seInfo,
                               int32_t flags, int32_t callerUid,
                               const android::sp<IAppDataOperationCallback>& callback);
binder::Status moveAppDataPath(const std::optional<std::string>& uuid,
                               const std::string& fromPath, const std::string& toPath,
                               int32_t userId, int32_t appId, const std::string& seInfo,
                               int32_t flags, int32_t callerUid,
                               const android::sp<IAppDataOperationCallback>& callback);
```

实现刻意在打开的文件描述符上使用 `*at()` 系列 syscall，而不是 `std::filesystem`。这专门是为了避免 TOCTOU 攻击。一个被检查不是符号链接的路径可能在操作中途被换成另一个。通过 fd 工作使操作固定到被验证的 inode。这些方法自己强制执行的唯一结构限制是源路径和目标路径都必须位于 CE 或 DE 应用数据根之下。更高层的策略由调用者负责。

`installd` 在 17 中还加强了存储卫生。它现在在应用数据操作中验证源所有权。它把 inode 配额设置限制到应用 UID。它默认禁用硬 inode 配额。这些是对 12.7.9 中描述的配额和所有权处理的纵深防御修复，而不是新 API。

### 12.11.2 InputFlinger：InteractionReporter 阶段

输入流水线（12.3.2）在 `InputFilter` 与分发器之间获得一个新的监听器阶段。自 17 起，`frameworks/native/services/inputflinger/InputManager.cpp` 中构造函数接线的 `InputListener` 链是：

```
InputReader
  -> UnwantedInteractionBlocker
  -> PointerChoreographer
  -> InputProcessor
  -> InputDeviceMetricsCollector
  -> InputFilter
  -> InteractionReporter
  -> InputDispatcher
```

`InteractionReporter`（在 `frameworks/native/services/inputflinger/InteractionReporter.cpp`，`Android.bp` 第 93 行列名）观察事件流并向感兴趣的系统组件报告用户交互信号。例如，它把交互提供方与 attention service 的唤醒 API 链接起来，让用户活动可以保持 attention 感知功能清醒。它是纯粹的观察者。它作为 `TracedInputListener` 坐在流水线中，把每个事件原样转发给分发器。所以它不给事件路由增加任何行为变化。

相应地，`InputManager` 把它作为专用成员拥有：

> `frameworks/native/services/inputflinger/InputManager.h`

```cpp
std::unique_ptr<InteractionReporterInterface> mInteractionReporter;
```

### 12.11.3 SensorService：挂起冻结客户端

17 中的 SensorService 停止向进程被**冻结**（framework 通过 freezer cgroup 冻结的缓存应用）的客户端交付传感器事件。以前，冻结客户端的 `SensorEventConnection` 会保持其传感器激活，浪费功耗产生应用无法消费的事件。

该机制挂钩 Binder 的冻结状态通知。SensorService 记录每个连接的客户端 PID，并注册一个 `ClientStateRecipient`，它同时实现该客户端的死亡接收者和冻结状态回调：

> `frameworks/native/services/sensorservice/SensorService.h`

```cpp
class ClientStateRecipient : public IBinder::DeathRecipient,
                             public IBinder::FrozenStateChangeCallback {
    // ...
    bool isFrozen() const { /* ... */ return mIsFrozen; }
};
```

当客户端进程被冻结时，`onStateChanged()` 触发。相应的传感器连接被禁用以专用原因（`DISABLED_REASON_PID_FROZEN`，定义在 `SensorDevice.h` 中），事件交付暂停。当进程解冻时，连接被重新启用。该功能由 `android.hardware.flags.suspend_sensor_event_delivery_on_frozen_pid` 门控。

SensorService 在 17 中还添加了**每传感器活跃时间跟踪**。旧的每连接 `FlushInfo` 被重构为 `SensorConnectionRecord`。一个 `UsageStats` 结构现在跟踪每个传感器的激活时间和总活跃时长，并计入 UID 空闲挂起。这浮现在 `dumpsys sensorservice` 中并支持平台功耗归因。

### 12.11.4 SurfaceFlinger：Mirror with Crop、Display LUT 与内容过滤

SurfaceFlinger 的内部 `mirrorLayer()` 获得一个 crop 句柄。有了它，镜像 surface 可以被裁剪到源的一个子区域，而不是镜像整个 layer 子树：

> `frameworks/native/services/surfaceflinger/SurfaceFlinger.h`

```cpp
status_t mirrorLayer(const LayerCreationArgs& args, const sp<IBinder>& mirrorFromHandle,
                     const sp<IBinder>& stopAtHandle, const sp<IBinder>& cropByHandle,
                     gui::CreateSurfaceResult& outResult);
```

在 16 中此方法只接受 `mirrorFromHandle` 和 `stopAtHandle`；`cropByHandle` 参数是 17 的新增。

在色彩管理侧（12.2.15），17 延续了每 layer **display LUT**（查找表）。layer 可以选择使用 LUT，其绘制状态中的 `useLuts` 标志跟踪。SurfaceFlinger 还可以从 **SMPTE ST 2094-50** 动态色调映射元数据生成 LUT。合成路径和 `dumpsys SurfaceFlinger` 现在记录应用提供的和生成的 LUT 以及 2094-50 元数据，这有助于诊断 HDR 色调映射决策。

还有两个标志值得注意，因为它们塑造了前面覆盖的行为：

- **`virtual_display_content_filtering`**（命名空间 `window_surfaces`）让 SurfaceFlinger 过滤虚拟显示允许捕获的内容，加固安全应用免受通过虚拟显示的未经授权内容捕获。
- **`synced_resolution_switch`**（命名空间 `core_graphics`）同步显示分辨率 modeset 与 framebuffer 调整大小。SurfaceFlinger 只在启动完成后应用它：

> `frameworks/native/services/surfaceflinger/SurfaceFlinger.h`

```cpp
bool shouldSyncResolutionSwitch() const {
    return FlagManager::getInstance().synced_resolution_switch() &&
            mBootStage == BootStage::FINISHED;
}
```

这些标志位于 `surfaceflinger_flags_new.aconfig`，即尚未折叠进长期 `surfaceflinger_flags.aconfig` 的标志的暂存文件。

### 12.11.5 servicemanager、dumpsys 与 GpuService 完善

**servicemanager：隔离应用可以等待懒服务。**早期版本直接以 `EX_SECURITY` 拒绝来自隔离应用进程的 `registerForNotifications()`。这破坏了试图到达懒服务的隔离客户端（例如 AICore）的 `AServiceManager_waitForService()`。

在 17 中，`servicemanager` 允许隔离应用注册通知，并把安全决策推迟到注册时间。一个新的 `RegistrationCallback` 结构记录等待客户端的 UID。`allowIsolated` 检查位于服务查找路径（`tryGetBinder()`，被 `getService()` 和 `checkService()` 使用）。它们也位于 `dispatchRegistrationCallbacks()` 中。`addService()` 和 `registerForNotifications()` 在触发任何回调之前都经过它。

如果服务以 `allowIsolated=false` 注册，隔离客户端的通知被静默丢弃，所以不会暴露受限服务。净效果是隔离客户端现在可以等待并连接到选择加入隔离访问的懒服务。未选择加入的服务不会被泄露。

> `frameworks/native/cmds/servicemanager/ServiceManager.cpp`

**dumpsys：`-w` 等待懒服务。**`dumpsys` 获得一个 `-w` 标志，镜像 `cmd -w`。有了它，`dumpsys` 在转储前无限期等待懒（按需）服务就绪。没有此标志，当服务尚未注册时命令快速失败：

> `frameworks/native/cmds/dumpsys/dumpsys.cpp`

```
-w: wait for service indefinitely to be ready before dumping
```

这与 12.10.9 描述的懒服务生命周期自然配对。一个只在按需时启动的服务现在可以用 `dumpsys -w <service>` 转储，而不会与它的第一个客户端竞争。

**GpuService：笔记本上的 GPU 工作跟踪。**eBPF GPU 工作跟踪器（12.8.4）在笔记本形态上不再硬性要求 `power/gpu_work_period` 内核 tracepoint，那里可能没有该 tracepoint。GpuService 还把其 BPF map 移到 `BpfMap::init`（而不是构造它们）。因此加载失败被优雅处理而不是中止。GpuService 还丢弃了一个过时的 ANGLE `angle_feature_overrides` 标志引用。这些是监控子系统的健壮性变化；12.8 描述的 GpuStats、GpuMem、GpuWork 和 ANGLE 作为系统驱动功能在其他方面不变。

---

## 12.12 动手练习

本节提供探索本章覆盖的原生服务的动手练习。

### 12.12.1 概览

下面的练习设计为在有 `adb` 访问的开发设备或模拟器上运行。一些练习需要 `root` 访问（在 `userdebug` 或 `eng` 构建上可用）。每个练习都建立在本章概念之上，从简单观察推进到主动实验。

### 练习 1：列出所有运行中的服务

连接设备或模拟器并列出所有已注册服务：

```bash
# List all services registered with servicemanager
adb shell service list

# List with dumpsys (shows running status)
adb shell dumpsys -l

# Count the total number of services
adb shell service list | wc -l
```

你通常会看到注册了 150-200 个服务。注意原生服务（像 `SurfaceFlinger`、`gpu`、`installd` 这样的简单名）和 Java 服务（像 `activity`、`window`、`package` 这样的名字）的混合。

### 练习 2：探索 SurfaceFlinger 状态

```bash
# Full SurfaceFlinger dump
adb shell dumpsys SurfaceFlinger

# Look for specific information
adb shell dumpsys SurfaceFlinger | grep "Display"
adb shell dumpsys SurfaceFlinger | grep "VSYNC"
adb shell dumpsys SurfaceFlinger | grep "Layer"

# Count visible layers
adb shell dumpsys SurfaceFlinger --list
```

在转储输出中，寻找：

- **显示配置**：分辨率、刷新率、色彩模式。
- **Layer 列表**：当前提交用于合成的每个 surface。
- **合成类型**：哪些 layer 是 DEVICE（硬件 overlay）而不是 CLIENT（GPU 合成）。
- **VSYNC 信息**：预测的 VSYNC 时间戳和调度参数。
- **帧统计**：错帧、jank 计数、合成时间。

### 练习 3：监控输入事件

```bash
# Watch raw input events
adb shell getevent -lt

# Watch interpreted input events (requires root)
adb shell dumpsys input

# Look for input devices
adb shell dumpsys input | grep "Device"
```

在 `getevent` 运行时触摸屏幕并观察：

1. `EV_ABS ABS_MT_TRACKING_ID`——触摸开始（分配跟踪 ID）。
2. `EV_ABS ABS_MT_POSITION_X/Y`——触摸坐标。
3. `EV_ABS ABS_MT_PRESSURE`——触摸压力。
4. `EV_SYN SYN_REPORT`——事件包结束。
5. `EV_ABS ABS_MT_TRACKING_ID ffffffff`——触摸结束（跟踪 ID -1）。

### 练习 4：检查 installd 操作

```bash
# Watch installd operations in real time
adb logcat -s installd

# Dump installd state
adb shell dumpsys installd

# Check app data directories (requires root)
adb shell ls -la /data/user/0/com.android.settings/
adb shell ls -la /data/user_de/0/com.android.settings/
```

在看 `logcat` 的同时安装一个新应用，观察 `createAppData`、`dexopt` 和 profile 设置操作。

### 练习 5：GPU 服务诊断

```bash
# Dump GPU service state
adb shell dumpsys gpu

# Get Vulkan device properties
adb shell cmd gpu vkjson

# Check Vulkan profile support
adb shell cmd gpu vkprofiles

# View GPU memory usage (if available)
adb shell dumpsys gpu --gpumem

# View GPU driver statistics
adb shell dumpsys gpu --gpustats
```

### 练习 6：传感器服务探索

```bash
# Dump all sensor information
adb shell dumpsys sensorservice

# Look for virtual sensors
adb shell dumpsys sensorservice | grep "AOSP"

# Watch sensor registrations
adb shell dumpsys sensorservice | grep "Connection"
```

在输出中，识别：

- **物理传感器**：带 vendor 名的硬件传感器。
- **虚拟传感器**：AOSP 提供的融合传感器（Rotation Vector、Game Rotation Vector 等）。
- **活跃连接**：哪些应用当前正在接收传感器数据以及什么速率。

### 练习 7：servicemanager 内部

注意 `dumpsys manager` 不打印任何东西。`ServiceManager` 从不覆盖 `dump()`，所以它继承 `BBinder::dump()`（`frameworks/native/libs/binder/Binder.cpp:608`）。该方法不写任何输出并返回 `NO_ERROR`。改为通过服务列表检查注册表。

```bash
# List every service name the registry knows about
adb shell dumpsys -l

# Check if a specific service is registered
adb shell service check SurfaceFlinger
adb shell service check installd

# List all registered services
adb shell service list
```

### 练习 8：端到端追踪 Binder 调用

用 Perfetto 追踪一个完整 Binder 事务：

```bash
# Record a 5-second trace with Binder and scheduling info
adb shell perfetto \
  -c - --txt \
  -o /data/misc/perfetto-traces/native-services.perfetto-trace \
  <<EOF
buffers: {
    size_kb: 63488
    fill_policy: DISCARD
}
data_sources: {
    config {
        name: "linux.ftrace"
        ftrace_config {
            ftrace_events: "sched/sched_switch"
            ftrace_events: "binder/binder_transaction"
            ftrace_events: "binder/binder_transaction_received"
        }
    }
}
duration_ms: 5000
EOF

# Pull and analyze in the Perfetto UI
adb pull /data/misc/perfetto-traces/native-services.perfetto-trace
```

在 Perfetto UI（https://ui.perfetto.dev）中打开追踪并寻找：

- 应用进程与原生服务之间的 Binder 事务。
- SurfaceFlinger 合成周期的线程调度。
- VSYNC 时序关系。

### 练习 9：构建并修改原生服务

为理解构建系统集成，尝试修改一个简单的原生服务：

```bash
# Navigate to the GPU service
cd $AOSP_ROOT/frameworks/native/services/gpuservice/

# Edit main_gpuservice.cpp - add a log message at startup
# Before sm->addService(...), add:
# ALOGI("GpuService starting - custom build");

# Build just the GPU service module
cd $AOSP_ROOT
m gpuservice

# The output binary will be at:
# out/target/product/<device>/system/bin/gpuservice
```

### 练习 10：观察 SurfaceFlinger 合成类型

```bash
# Dump SurfaceFlinger layer state
adb shell dumpsys SurfaceFlinger --list

# Get detailed composition information
adb shell dumpsys SurfaceFlinger | grep -A5 "Composition type"

# Watch composition type changes in real-time with systrace
adb shell atrace --list_categories | grep gfx
```

在观看 SurfaceFlinger 转储时打开视频播放器。注意：

- 视频 surface 通常合成为 `DEVICE`（硬件 overlay）以避免视频帧的 GPU 拷贝。
- UI overlay（播放按钮、进度条）如果混合模式复杂可能合成为 `CLIENT`（GPU）。
- 状态栏和导航栏是有各自合成类型的独立 layer。

### 练习 11：探索输入流水线延迟

```bash
# Enable input event tracing
adb shell atrace -c input -b 32768 -t 5 > /tmp/input-trace.txt

# Or use Perfetto for more detailed analysis
cat > /tmp/input_trace_config.txt << 'EOF'
buffers { size_kb: 32768 fill_policy: DISCARD }
data_sources {
    config {
        name: "linux.ftrace"
        ftrace_config {
            ftrace_events: "input/input_event"
            ftrace_events: "sched/sched_switch"
            ftrace_events: "sched/sched_wakeup"
        }
    }
}
duration_ms: 5000
EOF

adb push /tmp/input_trace_config.txt /data/local/tmp/
adb shell perfetto -c /data/local/tmp/input_trace_config.txt \
    -o /data/misc/perfetto-traces/input.perfetto-trace
adb pull /data/misc/perfetto-traces/input.perfetto-trace
```

在追踪捕获期间触摸屏幕，然后分析追踪以测量：

- **硬件到 EventHub**：从内核事件时间戳到 EventHub 读取的时间。
- **EventHub 到 InputReader**：读取器线程中的处理时间。
- **InputReader 到 InputDispatcher**：穿过流水线阶段的时间。
- **InputDispatcher 到应用**：socket 写入 + 应用主线程唤醒。
- **应用处理**：从事件接收到完成信号的时间。

### 练习 12：应用安装期间监控 installd

```bash
# In one terminal, watch installd logs
adb logcat -s installd:* &

# In another terminal, install an APK
adb install some-app.apk

# Watch for these key operations:
# - createAppData: Creating the app's data directories
# - dexopt: Optimizing the DEX code
# - restorecon: Setting SELinux labels
# - Profile operations: Setting up profiling
```

安装后，验证数据布局：

```bash
# List the app's data directories (requires root)
adb shell su -c "ls -la /data/user/0/com.example.app/"
adb shell su -c "ls -la /data/user_de/0/com.example.app/"

# Check the OAT (compiled code) files
adb shell su -c "find /data/app/ -name '*.oat' -o -name '*.vdex' | head -10"

# Check the profile
adb shell su -c "ls -la /data/misc/profiles/cur/0/com.example.app/"
adb shell su -c "ls -la /data/misc/profiles/ref/com.example.app/"
```

### 练习 13：检查服务进程隔离

```bash
# View the processes and their UIDs
adb shell ps -A | grep -E "surface|sensor|audio|camera|install|gpu"

# Check the capabilities of a service process (requires root)
adb shell su -c "cat /proc/$(pidof surfaceflinger)/status | grep Cap"

# Decode the capabilities on your workstation -- AOSP ships only
# getcap/setcap (no capsh on the device), so pull the CapEff hex mask
# and decode it host-side
capsh --decode=$(adb shell su -c "grep CapEff /proc/\$(pidof surfaceflinger)/status" | awk '{print $2}')

# Check SELinux context of a service
adb shell ps -Z | grep -E "surfaceflinger|installd|sensorservice"

# View the seccomp filter (if applicable)
adb shell su -c "cat /proc/$(pidof media.codec)/status | grep Seccomp"
```

### 练习 14：服务死亡与恢复

在 `userdebug` 或 `eng` 构建上，你可以观察崩溃恢复：

```bash
# In one terminal, watch for crash/recovery
adb logcat -s init:* servicemanager:* &

# Kill a non-critical service (DO NOT kill surfaceflinger on
# production -- it will restart zygote and all apps!)
adb shell su -c "kill -9 $(pidof gpuservice)"

# Watch the logs for:
# 1. init detecting the death
# 2. servicemanager getting the death notification
# 3. init restarting the service
# 4. The service re-registering with servicemanager

# Verify the service came back
adb shell service check gpu
```

对于 SurfaceFlinger，恢复更戏剧性：

```bash
# WARNING: This will restart all applications!
# Only do this on a test device.
adb shell su -c "kill -9 $(pidof surfaceflinger)"

# Watch for the cascading restart:
# 1. SurfaceFlinger dies
# 2. init restarts SurfaceFlinger
# 3. onrestart triggers zygote restart
# 4. All app processes are killed and restarted
# 5. The boot animation briefly plays
# 6. The lock screen appears
```

### 练习 15：比较 servicemanager 变体

检查同一份源码如何构建成不同的二进制：

```bash
# System servicemanager
adb shell ls -la /system/bin/servicemanager

# Vendor servicemanager
adb shell ls -la /vendor/bin/vndservicemanager

# Check which binder device each uses
adb shell cat /proc/$(pidof servicemanager)/cmdline | tr '\0' ' '
adb shell cat /proc/$(pidof vndservicemanager)/cmdline | tr '\0' ' '
```

vendor servicemanager 用 `-DVENDORSERVICEMANAGER` 编译，它禁用 VINTF 清单检查和 Perfetto 追踪。它还改变 SELinux context 查找以使用 `vendor_service_contexts` 而不是 `service_contexts`。

---

### 练习 16：分析 GPU 驱动统计

```bash
# Dump complete GPU service state
adb shell dumpsys gpu

# Get Vulkan device properties in JSON format
adb shell cmd gpu vkjson | python3 -m json.tool | head -50

# Check which GPU driver is in use
adb shell getprop ro.gfx.driver.0
adb shell getprop persist.graphics.egl

# View per-app GPU stats
adb shell dumpsys gpu --gpustats
```

### 练习 17：实践中的传感器融合

```bash
# List all registered sensors
adb shell dumpsys sensorservice | grep "handle"

# Identify virtual sensors (vendor = "AOSP")
adb shell dumpsys sensorservice | grep -B2 "AOSP"

# Watch sensor activity
adb shell dumpsys sensorservice | grep "active"

# Check sensor direct channel support
adb shell dumpsys sensorservice | grep "direct"
```

在设备上使用指南针或水平仪应用。然后转储传感器服务。看看哪些物理传感器（加速度计、陀螺仪、磁力计）被激活。还要看看它们如何馈送给虚拟旋转矢量传感器。

### 练习 18：servicemanager SELinux 策略

```bash
# View the service_contexts file
adb shell cat /system/etc/selinux/plat_service_contexts | head -30

# Check which SELinux domain a service runs in
adb shell ps -Z | grep surfaceflinger
# Output: u:r:surfaceflinger:s0

# Verify that an app cannot access installd directly
# (This should fail due to SELinux policy)
adb shell run-as com.android.settings service call installd 1
```

### 练习 19：检查 Binder 线程池

```bash
# View Binder threads for a service
adb shell su -c "ls /proc/$(pidof surfaceflinger)/task/"

# Count Binder threads
adb shell su -c "ls /proc/$(pidof surfaceflinger)/task/ | wc -l"

# View thread names
for tid in $(adb shell su -c "ls /proc/$(pidof surfaceflinger)/task/"); do
    name=$(adb shell su -c "cat /proc/$(pidof surfaceflinger)/task/$tid/comm")
    echo "  $tid: $name"
done
```

观察不同服务如何有不同数量的线程：

- `servicemanager`：很少（1-2）——单线程 Looper 模型。
- `surfaceflinger`：中等（10-20）——合成线程、Binder 线程、事件线程。
- `audioserver`：很多线程——每个活跃音频流一个加上 Binder。

### 练习 20：端到端触摸事件追踪

这是顶点练习。追踪一个触摸事件从内核穿过整个原生服务栈：

```bash
# Step 1: Start tracing (atrace writes the trace to stdout,
# which we redirect into a file on the host)
adb shell atrace -c input view gfx -b 65536 -t 10 > trace.txt &

# Step 2: Touch the screen and interact with an app

# Step 3: When atrace finishes, the trace is in trace.txt

# Or use Perfetto for a more detailed trace:
cat > /tmp/e2e_config.pbtx << 'EOF'
buffers { size_kb: 65536 }
data_sources {
    config {
        name: "linux.ftrace"
        ftrace_config {
            ftrace_events: "input/*"
            ftrace_events: "sched/sched_switch"
            ftrace_events: "sched/sched_wakeup"
            ftrace_events: "binder/binder_transaction"
            ftrace_events: "binder/binder_transaction_received"
            ftrace_events: "mdss/*"
        }
    }
}
data_sources {
    config { name: "android.surfaceflinger.frametimeline" }
}
duration_ms: 10000
EOF
```

在追踪中，跟随单个触摸事件穿过：

1. **内核**（`input_event`）：触摸屏驱动生成原始事件。
2. **EventHub**（`input_reader` 线程）：从 `/dev/input/eventN` 读取。
3. **InputReader**：把原始事件转换为 `NotifyMotionArgs`。
4. **流水线阶段**：`UnwantedInteractionBlocker` -> `PointerChoreographer` -> `InputProcessor` -> `MetricsCollector` -> `InputFilter`。
5. **InputDispatcher**（`input_dispatcher` 线程）：路由到目标窗口。
6. **应用**（`main` 线程）：通过 `InputChannel` socket 接收。
7. **应用渲染**：应用处理事件并渲染一帧。
8. **SurfaceFlinger**：在下一个 VSYNC 合成新帧。
9. **显示**：帧出现在屏幕上。

在现代化设备上，从触摸到像素的端到端总延迟通常为 40-100ms。流水线贡献其中约 4-8ms。

---

## 总结

本章调查了构成 Android 系统功能骨干的主要原生服务。以下是关键服务及其作用的回顾：

| 服务 | 二进制 | 注册名 | 主要作用 |
|---------|--------|-------------------|--------------|
| servicemanager | `servicemanager` | `manager` | 服务注册与发现 |
| SurfaceFlinger | `surfaceflinger` | `SurfaceFlinger` | 显示合成 |
| InputFlinger | （在 system_server 中） | `inputflinger` | 输入事件路由 |
| AudioFlinger | `audioserver` | `media.audio_flinger` | 音频混音与路由 |
| CameraService | `cameraserver` | `media.camera` | 相机硬件管理 |
| MediaCodecService（旧版 OMX） | `android.hardware.media.omx@1.0-service`（argv[0] `media.codec`） | `IOmx`（HIDL） | 旧版 vendor OMX codec HAL；当前路径是通过 `mediaswcodec` 的 Codec2 |
| installd | `installd` | `installd` | APK 安装、dexopt |
| GpuService | `gpuservice` | `gpu` | GPU 统计与驱动管理 |
| SensorService | `sensorservice` | `sensorservice` | 传感器访问与融合 |

我们观察到的跨所有服务的关键架构模式：

1. **基于 Binder 的 IPC**：每个服务都通过 Binder 通信，SELinux 在每次事务上强制访问控制。

2. **HAL 抽象**：面向硬件的服务（SurfaceFlinger、AudioFlinger、SensorService）使用抽象 AIDL 和 HIDL HAL 版本的 HAL 包装类。

3. **线程模型**：服务在基于 Looper 的事件循环（servicemanager）、线程池（大多数服务）和专用线程（SurfaceFlinger 的 Scheduler、InputFlinger 的 reader/dispatcher 线程）之间选择。

4. **优先级转储**：服务实现 `PriorityDumper` 以支持通过 `dumpsys` 的结构化诊断输出。

5. **权限分离**：服务以所需的最小权限运行，使用 Linux capabilities、SELinux 和 seccomp-bpf 沙箱。

6. **崩溃恢复**：`init` 进程监控所有原生服务并在崩溃时重启它们，`onrestart` 触发器级联到依赖服务。

### 架构经验

研究这些原生服务浮现出几个设计原则：

**1. 数据路径与控制路径分离**

性能最高的服务（AudioFlinger、SensorService、InputFlinger）把高频数据路径与低频控制路径分离：

- **数据路径**：共享内存（AudioFlinger）、socket 对（InputFlinger、SensorService）或直接内存映射（SensorService 直接通道）。这些完全绕过 Binder。
- **控制路径**：用于不频繁发生的设置、配置和拆除操作的 Binder IPC。

**2. 双缓冲状态**

SurfaceFlinger 和 InputFlinger 都使用双缓冲状态以允许并发读写：

- SurfaceFlinger 有 `mCurrentState`（由 Binder 线程写入）和 `mDrawingState`（由合成线程读取）。
- InputFlinger 有独立的 reader 和 dispatcher 线程，之间有队列。

此模式消除了热路径上的锁竞争。

**3. 预测性调度**

SurfaceFlinger 的 `VSyncPredictor` 把数学模型拟合到硬件 VSYNC 时间戳，允许它预测未来的 VSYNC 时间并在恰当时刻唤醒。这最小化延迟（唤醒太晚）和浪费的 CPU 时间（唤醒太早）。

**4. 渐进特权**

把特权操作委托给专用守护进程的 `installd` 模式在 Android 中反复出现：

- `installd` 为 `PackageManagerService` 处理文件系统操作。
- `vold` 为 `StorageManagerService` 处理卷挂载。
- `keystore2` 为 framework 的 Keystore/KeyMint API 处理密钥存储和密码操作，系统服务和应用都使用。

这最小化 Java 系统服务的特权，它们更复杂因而更可能有漏洞。

**5. HAL 抽象**

每个面向硬件的服务都把它与 HAL 的接口包装在支持多个 HAL 版本的抽象层中：

- `SensorDevice` 包装 `ISensorHalWrapper`（AIDL 和 HIDL）。
- `HWComposer` 包装 `IComposer`（AIDL v3）。
- `AudioFlinger` 包装 Audio HAL（AIDL）。

这允许服务在持续进行的 HIDL 到 AIDL 迁移期间同时与新旧 HAL 实现一起工作。

### 源文件参考

本章引用的所有源路径都相对于 AOSP 根：

| 组件 | 关键源路径 |
|-----------|-----------------|
| servicemanager | `frameworks/native/cmds/servicemanager/` |
| SurfaceFlinger | `frameworks/native/services/surfaceflinger/` |
| InputFlinger | `frameworks/native/services/inputflinger/` |
| AudioFlinger | `frameworks/av/services/audioflinger/` |
| CameraService | `frameworks/av/services/camera/` |
| MediaCodecService | `frameworks/av/services/mediacodec/` |
| Codec2 | `frameworks/av/media/codec2/` |
| installd | `frameworks/native/cmds/installd/` |
| GpuService | `frameworks/native/services/gpuservice/` |
| SensorService | `frameworks/native/services/sensorservice/` |
| dumpsys | `frameworks/native/cmds/dumpsys/` |

接下来的章节更详细地描述特定子系统。它们覆盖图形合成流水线（第 13 章）、音频流水线（第 15 章）和媒体/相机流水线（第 16 章）。
