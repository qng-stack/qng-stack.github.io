---
title: "第 38 章：NFC（近场通信）"
description: "近场通信（NFC）是一种工作在 13.56 MHz、典型作用距离仅数厘米的短距离无线技术。它建立在与非接触智能卡相同的 ISO/IEC 14443 与 FeliCa 标准之上，但增加了点对点这一维度。Android 自 API 级别 9（Android 2.3，Gingerbread）起就支持 NFC，其协议栈也..."
pubDate: 2026-11-06T13:11:49
---

# 第 38 章：NFC（近场通信）

近场通信（NFC）是一种工作在 13.56 MHz、典型作用距离仅数厘米的短距离无线技术。它建立在与非接触智能卡相同的 ISO/IEC 14443 与 FeliCa 标准之上，但增加了点对点这一维度。Android 自 API 级别 9（Android 2.3，Gingerbread）起就支持 NFC，其协议栈也历经数代架构演进。

NFC 的决定性特征是其极短的作用距离——通常为 0–4 cm。这使得物理接近本身成为一种天然的认证因素：你必须有意地去贴近，才能支付、分享或认证。在这个意义上，射频链路本身是被动的：一台设备（读取器/发起方）产生射频场，另一台设备（标签/卡/目标）通过调制该射频场来通信。

---

## 38.1 NFC 架构

### 38.1.1 NFC 标准与工作模式

NFC 涵盖若干 ISO 标准与行业标准，在 AOSP 源码中每种标准都映射到一种“技术”（technology）：

| 标准 | AOSP 技术 | 常见用途 |
|----------|----------------|------------|
| ISO 14443-3A | NfcA | MIFARE、大多数标签 |
| ISO 14443-3B | NfcB | 电子护照、部分交通卡 |
| ISO 14443-4 | IsoDep | 智能卡、HCE |
| JIS X 6319-4 | NfcF | FeliCa（日本交通、支付） |
| ISO 15693 | NfcV | 图书标签、仓储标签 |
| ISO 14443-3A 变体 | MifareClassic | 旧式门禁卡 |
| ISO 14443-3A 变体 | MifareUltralight | 活动门票 |
| NFC-DEP (ISO 18092) | （已废弃） | 原 Android Beam |

Android 以三种基本模式运行 NFC：

1. **读/写模式**——手机产生射频场，与被动标签或智能卡通信。
2. **卡模拟模式**——手机表现为非接触智能卡，响应外部读取器的射频场。这可以是主机卡模拟（HCE，由应用处理器处理），也可以是离主机（off-host）方式（由安全元件处理）。
3. **点对点模式**——两台 NFC 设备双向交换数据。该模式曾用于 Android Beam，后者已在 Android 10 中废弃。

### 38.1.2 AOSP NFC 协议栈：分层结构

Android 的 NFC 实现构成一套分层协议栈，从应用层 Java 代码一直延伸到厂商特定的硬件：

```mermaid
graph TB
    subgraph "应用层"
        A1["使用 NfcAdapter 的应用"]
        A2["HostApduService\n(HCE)"]
        A3["HostNfcFService\n(HCE-F)"]
    end

    subgraph "框架层"
        F1["android.nfc.NfcAdapter"]
        F2["android.nfc.NdefMessage\nandroid.nfc.NdefRecord"]
        F3["android.nfc.tech.*\n(NfcA, NfcB, NfcF,\nNfcV, IsoDep, Ndef, ...)"]
        F4["android.nfc.cardemulation.*\n(CardEmulation,\nHostApduService, ...)"]
    end

    subgraph "NfcService（系统）"
        S1["NfcService\n(com.android.nfc)"]
        S2["NfcDispatcher"]
        S3["CardEmulationManager"]
        S4["HostEmulationManager"]
        S5["AidRoutingManager"]
    end

    subgraph "NCI / JNI 层"
        N1["NativeNfcManager\n(dhimpl)"]
        N2["libnfc-nci\n(C 库)"]
        N3["JNI 桥\n(nfc_nci_jni)"]
    end

    subgraph "HAL 层"
        H1["INfc (AIDL HAL)\n@VintfStability"]
        H2["INfcClientCallback"]
    end

    subgraph "硬件"
        HW1["NFC 控制器\n(NFCC)"]
        HW2["安全元件\n(eSE / UICC)"]
    end

    A1 --> F1
    A2 --> F4
    A3 --> F4
    F1 --> S1
    F2 --> S1
    F3 --> S1
    F4 --> S3
    S1 --> S2
    S1 --> S3
    S3 --> S4
    S3 --> S5
    S1 --> N1
    N1 --> N3
    N3 --> N2
    N2 --> H1
    H1 --> H2
    H1 --> HW1
    HW1 --> HW2
```

### 38.1.3 关键源码目录

NFC 实现横跨 AOSP 源码树中的多个目录：

| 目录 | 用途 |
|-----------|---------|
| `packages/modules/Nfc/framework/` | 公开 API：`NfcAdapter`、`NdefMessage`、`NdefRecord`、各技术类 |
| `packages/modules/Nfc/NfcNci/src/com/android/nfc/` | NfcService、NfcDispatcher 及核心系统逻辑 |
| `packages/modules/Nfc/NfcNci/src/com/android/nfc/cardemulation/` | HCE 与卡模拟子系统 |
| `packages/modules/Nfc/NfcNci/nci/src/com/android/nfc/dhimpl/` | 原生接口（NativeNfcManager） |
| `packages/modules/Nfc/NfcNci/nci/jni/` | 连接 Java 与 libnfc-nci 的 JNI C++ 代码 |
| `packages/modules/Nfc/libnfc-nci/` | NCI 协议栈（C 库） |
| `hardware/interfaces/nfc/aidl/` | AIDL HAL 接口定义 |
| `hardware/interfaces/nfc/1.0/` 至 `1.2/` | 旧式 HIDL HAL 接口 |
| `packages/modules/Nfc/apex/` | Mainline APEX 打包配置 |

### 38.1.4 NfcAdapter：应用入口

`NfcAdapter` 是面向应用的适配器单例，是所有 NFC 操作的入口。应用通过一次静态调用即可获取它：

```java
// Source: packages/modules/Nfc/framework/java/android/nfc/NfcAdapter.java
public final class NfcAdapter {
    // The three tag dispatch intents, in priority order:
    public static final String ACTION_NDEF_DISCOVERED =
            "android.nfc.action.NDEF_DISCOVERED";
    public static final String ACTION_TECH_DISCOVERED =
            "android.nfc.action.TECH_DISCOVERED";
    public static final String ACTION_TAG_DISCOVERED =
            "android.nfc.action.TAG_DISCOVERED";

    // Reader mode flags
    public static final int FLAG_READER_NFC_A = 0x1;
    public static final int FLAG_READER_NFC_B = 0x2;
    public static final int FLAG_READER_NFC_F = 0x4;
    public static final int FLAG_READER_NFC_V = 0x8;
    public static final int FLAG_READER_NFC_BARCODE = 0x10;
    public static final int FLAG_READER_SKIP_NDEF_CHECK = 0x80;
    public static final int FLAG_READER_NO_PLATFORM_SOUNDS = 0x100;
    ...
}
```

适配器通过 Binder 接口（`INfcAdapter.aidl`）与 `NfcService` 通信。关键方法包括：

- `enableReaderMode()` / `disableReaderMode()` —— 独占式标签读取
- `enableForegroundDispatch()` / `disableForegroundDispatch()` —— 把标签优先路由到前台 Activity
- `isEnabled()` —— 查询 NFC 硬件状态
- `ignore()` —— 对特定标签做去抖（debounce）

### 38.1.5 NfcService：系统服务组件

`NfcService` 是核心守护服务，也是体量较大的系统服务之一。它运行在 `com.android.nfc` 进程中，使用共享 UID `android.uid.nfc`（见 `NfcNci/AndroidManifest.xml`）。它**并不**属于 `system_server`，而是运行在自己的进程中：

```
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcService.java
public class NfcService implements DeviceHostListener, ForegroundUtils.Callback {
    static final String TAG = "NfcService";
    public static final String SERVICE_NAME = "nfc";
    ...
}
```

NfcService 的职责：

- 通过 NCI 协议栈初始化并管理 NFC 硬件
- 处理屏幕状态变化（熄屏时关闭轮询）
- 把发现的标签路由到正确的应用
- 管理 HCE 卡模拟子系统
- 维护 NFCC 路由表
- 暴露供 NfcAdapter 使用的 Binder API

### 38.1.6 NFC HAL：硬件抽象

HAL 在 NCI 协议栈与厂商的 NFC 控制器驱动之间起中介作用。当前接口基于 AIDL（`android.hardware.nfc.INfc`），并带有 `@VintfStability` 以兼容 Mainline。该 HAL 恰好提供了 NCI 主机所需的那组操作：

```
// Source: hardware/interfaces/nfc/aidl/aidl_api/android.hardware.nfc/current/
//         android/hardware/nfc/INfc.aidl
@VintfStability
interface INfc {
    void open(in INfcClientCallback clientCallback);
    void close(in NfcCloseType type);
    void coreInitialized();
    void factoryReset();
    NfcConfig getConfig();
    void powerCycle();
    void preDiscover();
    int write(in byte[] data);
    void setEnableVerboseLogging(in boolean enable);
    boolean isVerboseLoggingEnabled();
    NfcStatus controlGranted();
}
```

### 38.1.7 NCI：NFC 控制器接口

NFC 控制器接口（NCI）是主机（应用处理器）与 NFC 控制器（NFCC）之间的标准化协议。AOSP 的实现位于 `libnfc-nci`，这是一个用 C 编写、实现了 NCI 1.0 与 2.0 规范的库。

NCI 协议采用命令/响应/通知模型：

```mermaid
sequenceDiagram
    participant Host as 主机（libnfc-nci）
    participant NFCC as NFC 控制器

    Host->>NFCC: NCI 命令（经 HAL write()）
    NFCC-->>Host: NCI 响应（经 HAL 回调 sendData()）
    Note over Host,NFCC: 异步通知
    NFCC-->>Host: NCI 通知（经 HAL 回调 sendData()）
```

NCI 消息按组 ID（GID）与操作码 ID（OID）分类：

| GID | 用途 |
|-----|---------|
| 0x00 | NCI 核心（RESET、INIT、SET_CONFIG） |
| 0x01 | 射频管理（DISCOVER、ACTIVATE） |
| 0x02 | NFCEE 管理（安全元件） |
| 0x0F | 专有（厂商特定） |

### 38.1.8 NFC 作为 Mainline 模块（APEX）

从近期的 Android 版本开始，NFC 协议栈被打包为 Mainline 模块（`com.android.nfcservices`），使 Google 能够独立于完整 OS 更新来更新 NFC。该 APEX 包包含：

- `NfcNci` APK（NfcService、卡模拟、分发逻辑）
- NFC 框架类
- `libnfc-nci` 原生库
- JNI 桥

APEX 清单文件位于：

```
packages/modules/Nfc/apex/manifest.json
```

### 38.1.9 端到端：从射频场到 Intent

当用户把手机贴近 NFC 标签时，完整的数据通路如下：

```mermaid
sequenceDiagram
    participant Tag as NFC 标签
    participant NFCC as NFC 控制器
    participant HAL as NFC HAL
    participant NCI as libnfc-nci
    participant JNI as JNI 桥
    participant NNM as NativeNfcManager
    participant SVC as NfcService
    participant DSP as NfcDispatcher
    participant APP as 应用

    Tag->>NFCC: 射频场调制
    NFCC->>HAL: NCI 通知（发现标签）
    HAL->>NCI: sendData() 回调
    NCI->>JNI: nfaConnectionCallback()
    JNI->>NNM: notifyNdefMessageListeners()
    NNM->>SVC: onRemoteEndpointDiscovered(TagEndpoint)
    SVC->>SVC: sendMessage(MSG_NDEF_TAG, tag)
    SVC->>SVC: 从标签读取 NDEF 数据
    SVC->>DSP: dispatchTag(tag)
    DSP->>DSP: 构造带 TAG、ID、NDEF extras 的 Intent
    DSP->>DSP: 尝试 ACTION_NDEF_DISCOVERED
    DSP->>DSP: 尝试 ACTION_TECH_DISCOVERED
    DSP->>DSP: 尝试 ACTION_TAG_DISCOVERED
    DSP->>APP: startActivity(matchingIntent)
```

---

## 38.2 NfcService

### 38.2.1 服务生命周期

NfcService 并不是传统的 Android Service 子类。它由 `NfcApplication` 在 `onCreate()` 中创建，并以 `"nfc"` 这一名称注册为系统服务。该服务在 NFC 进程的整个生命周期内持续存在。

其生命周期包括以下阶段：

```mermaid
stateDiagram-v2
    [*] --> ProcessStart: NfcApplication.onCreate
    ProcessStart --> NfcServiceCreated: new NfcService
    NfcServiceCreated --> BootTask: TASK_BOOT
    BootTask --> NfcOn: 设置中已启用 NFC
    BootTask --> NfcOff: 设置中已停用 NFC
    NfcOn --> NfcTurningOff: TASK_DISABLE
    NfcTurningOff --> NfcOff: 关闭完成
    NfcOff --> NfcTurningOn: TASK_ENABLE
    NfcTurningOn --> NfcOn: 初始化完成
    NfcOn --> HwError: onHwErrorReported
    HwError --> NfcTurningOff: restartStack
```

NfcService 的状态通过标准的 NfcAdapter 状态常量跟踪：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcService.java
int mState;  // NfcAdapter.STATE_ON, STATE_TURNING_ON,
             // STATE_OFF, STATE_TURNING_OFF
```

### 38.2.2 NfcApplication：启动引导

NFC 进程通过 `NfcApplication` 启动，后者是清单文件中声明的 `Application` 子类：

```xml
<!-- Source: packages/modules/Nfc/NfcNci/AndroidManifest.xml -->
<application android:name=".NfcApplication"
             android:icon="@drawable/icon"
             android:label="@string/app_name"
             android:theme="@android:style/Theme.Material.Light"
```

该进程以 UID `android.uid.nfc`（`sharedUserId`）运行，因而具备访问 NFC 硬件的特权。启动时，`NfcApplication.onCreate()` 构造 `NfcService` 单例并完成注册。

### 38.2.3 EnableDisableTask 状态机

NFC 硬件初始化由 `AsyncTask` 的子类 `EnableDisableTask` 处理。这样可以避免在可能相当缓慢的固件下载与 NFC 控制器初始化期间阻塞主线程：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcService.java
static final int TASK_ENABLE = 1;
static final int TASK_DISABLE = 2;
static final int TASK_BOOT = 3;
static final int TASK_ENABLE_ALWAYS_ON = 4;
static final int TASK_DISABLE_ALWAYS_ON = 5;
```

启用流程：

1. 校验固件（`mDeviceHost.checkFirmware()`）——可能触发固件下载
2. 初始化 NFC 控制器（`mDeviceHost.initialize()`）
3. 应用路由表
4. 开始轮询标签

看门狗定时器（`INIT_WATCHDOG_MS = 90000`，即 90 秒）用于防止固件下载卡死。这个较大的超时值是因为在某些硬件上 NFC 固件下载可能相当耗时。

### 38.2.4 屏幕状态管理

NFC 轮询行为与屏幕状态紧密耦合。熄屏时，系统通过减少或停止 NFC 轮询来节省功耗：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcService.java
// minimum screen state that enables NFC polling
static final int NFC_POLLING_MODE = ScreenStateHelper.SCREEN_STATE_OFF_UNLOCKED;
```

`ScreenStateHelper` 把显示状态映射为五个取值，这些取值构成一个位掩码，而非一个顺序序列（`packages/modules/Nfc/NfcNci/src/com/android/nfc/ScreenStateHelper.java`）：

| 屏幕状态 | 取值 | 轮询行为 |
|-------------|-------|-----------------|
| `SCREEN_STATE_UNKNOWN` | `0x00` | 视为熄屏 |
| `SCREEN_STATE_OFF_UNLOCKED` | `0x01` | 熄屏但设备已解锁（轮询阈值） |
| `SCREEN_STATE_OFF_LOCKED` | `0x02` | 熄屏且锁定 |
| `SCREEN_STATE_ON_LOCKED` | `0x04` | 受限轮询（锁屏支付） |
| `SCREEN_STATE_ON_UNLOCKED` | `0x08` | 完整轮询 |

这些取值之所以重要，是因为 `NfcService` 通过数值比较 `screenState >= NFC_POLLING_MODE` 来启用读取器轮询。当 `NFC_POLLING_MODE` 设为 `SCREEN_STATE_OFF_UNLOCKED`（`0x01`）时，所有取值大于等于 `0x01` 的状态都被允许，因此只有 `SCREEN_STATE_UNKNOWN`（`0x00`）低于阈值。由于这些常量是位掩码而非严格次序，决定轮询的实际是这个 `>=` 判断，而不是字面意义上的“屏幕是否点亮”检查。

屏幕状态变化会触发 `MSG_APPLY_SCREEN_STATE`，进而重新计算发现参数并相应更新 NFCC。

### 38.2.5 消息处理器

NfcService 通过 Handler 消息循环处理事件。所有关键操作都汇聚到若干消息常量上：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcService.java
static final int MSG_NDEF_TAG = 0;
static final int MSG_MOCK_NDEF = 3;
static final int MSG_ROUTE_AID = 5;
static final int MSG_UNROUTE_AID = 6;
static final int MSG_COMMIT_ROUTING = 7;
static final int MSG_RF_FIELD_ACTIVATED = 9;
static final int MSG_RF_FIELD_DEACTIVATED = 10;
static final int MSG_RESUME_POLLING = 11;
static final int MSG_REGISTER_T3T_IDENTIFIER = 12;
static final int MSG_DEREGISTER_T3T_IDENTIFIER = 13;
static final int MSG_TAG_DEBOUNCE = 14;
static final int MSG_APPLY_SCREEN_STATE = 16;
static final int MSG_TRANSACTION_EVENT = 17;
static final int MSG_PREFERRED_PAYMENT_CHANGED = 18;
static final int MSG_TOAST_DEBOUNCE_EVENT = 19;
static final int MSG_DELAY_POLLING = 20;
static final int MSG_CLEAR_ROUTING_TABLE = 21;
static final int MSG_UPDATE_ISODEP_PROTOCOL_ROUTE = 22;
static final int MSG_UPDATE_TECHNOLOGY_ABF_ROUTE = 23;
```

该处理器把本会相互竞争的操作串行化——特别是标签分发、路由表提交与屏幕状态变化。

### 38.2.6 标签发现：onRemoteEndpointDiscovered

当 NFC 控制器发现标签时，原生层通过 `DeviceHostListener` 回调把它送达：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcService.java
@Override
public void onRemoteEndpointDiscovered(TagEndpoint tag) {
    Log.d(TAG, "onRemoteEndpointDiscovered");
    sendMessage(MSG_NDEF_TAG, tag);
}
```

随后 `MSG_NDEF_TAG` 处理器会：

1. 读取标签的技术列表与 UID
2. 尝试从标签读取 NDEF 数据
3. 用发现到的信息构造 `Tag` parcelable
4. 把标签与 NDEF 消息交给 `NfcDispatcher`
5. 播放 NFC“发现标签”提示音
6. 启动存在性检查以检测标签离开

### 38.2.7 DeviceHost 与 DeviceHostListener

`DeviceHost` 是抽象原生 NFC 协议栈的接口。`NativeNfcManager` 实现该接口，而 `NfcService` 实现其监听器：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/DeviceHost.java
public interface DeviceHost {
    public interface DeviceHostListener {
        public void onRemoteEndpointDiscovered(TagEndpoint tag);
        public void onHostCardEmulationActivated(int technology);
        public void onHostCardEmulationData(int technology, byte[] data);
        public void onHostCardEmulationDeactivated(int technology);
        public void onRemoteFieldActivated();
        public void onRemoteFieldDeactivated();
        public void onNfcTransactionEvent(byte[] aid, byte[] data, String seName);
        public void onEeUpdated();
        public void onHwErrorReported();
        public void onPollingLoopDetected(List<PollingFrame> pollingFrames);
        public void onVendorSpecificEvent(int gid, int oid, byte[] payload);
        ...
    }

    public interface TagEndpoint {
        boolean connect(int technology);
        boolean reconnect();
        boolean disconnect();
        boolean presenceCheck();
        int[] getTechList();
        byte[] getUid();
        byte[] transceive(byte[] data, boolean raw, int[] returnCode);
        boolean checkNdef(int[] out);
        byte[] readNdef();
        boolean writeNdef(byte[] data);
        NdefMessage findAndReadNdef();
        boolean formatNdef(byte[] key);
        boolean isNdefFormatable();
        boolean makeReadOnly();
        ...
    }
}
```

`TagEndpoint` 接口内容相当丰富——它封装了对已发现标签的全部操作，从原始 transceive 到 NDEF 的读、写与格式化。

### 38.2.8 NativeNfcManager：JNI 桥

`NativeNfcManager` 是 `DeviceHost` 的实现，通过 JNI 把 Java 与原生 `libnfc-nci` 连接起来：

```java
// Source: packages/modules/Nfc/NfcNci/nci/src/com/android/nfc/dhimpl/NativeNfcManager.java
public class NativeNfcManager implements DeviceHost {
    static final String DRIVER_NAME = "android-nci";

    private long mNative;  // pointer to native structure

    private void loadLibrary() {
        System.loadLibrary("nfc_nci_jni");
    }

    public native boolean initializeNativeStructure();
    private native boolean doInitialize();
    private native boolean doDownload();
    ...
}
```

JNI 的 C++ 实现位于 `NfcNci/nci/jni/`，包含以下文件：

- `NativeNfcManager.cpp` —— 控制器初始化与管理
- `NativeNfcTag.cpp` —— 标签操作（读、写、transceive）
- `RoutingManager.cpp` —— AID 与技术路由
- `NfcTag.cpp` —— 标签状态跟踪
- `HciEventManager.cpp` —— 来自安全元件的 HCI 事件

### 38.2.9 读取器模式内部机制

当应用激活读取器模式时，NfcService 会重新配置 NFC 控制器，停用卡模拟与点对点功能，只专注于标签轮询：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcService.java
ReaderModeParams mReaderModeParams;

// Stored when enableReaderMode is called:
static class ReaderModeParams {
    int flags;
    IAppCallback callback;
    int presenceCheckDelay;
}
```

`ReaderModeDeathRecipient` 监视调用进程。若进程死亡，读取器模式会被自动停用，以防 NFC 控制器被锁定在非标准配置中：

```mermaid
sequenceDiagram
    participant App as 应用
    participant SVC as NfcService
    participant NFCC as NFC 控制器

    App->>SVC: enableReaderMode(flags, callback)
    SVC->>SVC: 保存 ReaderModeParams
    SVC->>SVC: 关联死亡接收者
    SVC->>NFCC: 更新发现参数
    Note over NFCC: 卡模拟已停用，<br/>仅轮询指定技术

    Note over App: 应用死亡或调用 disableReaderMode
    SVC->>SVC: 死亡接收者触发或显式停用
    SVC->>NFCC: 恢复正常发现
```

### 38.2.10 路由表管理

NFCC 维护一张路由表。该表决定 NFCC 把收到的 ISO-DEP、NFC-F 及其他帧送往何处：主机（应用处理器）、eSE 还是 UICC。NfcService 通过一个延迟调度器统一编排路由表更新，以合并多次快速变更：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcService.java
private final ScheduledExecutorService mRtUpdateScheduler =
        Executors.newScheduledThreadPool(1);

// On NFCEE update:
mRtUpdateScheduledTask = mRtUpdateScheduler.schedule(
    () -> {
        if (mIsHceCapable) {
            mCardEmulationManager.onTriggerRoutingTableUpdate();
        }
    },
    50,
    TimeUnit.MILLISECONDS);
```

路由由三个维度共同决定：

1. **AID 路由** —— 特定 AID 到特定目的地
2. **协议路由** —— ISO-DEP 帧到默认目的地
3. **技术路由** —— NFC-A/B/F 帧到默认目的地

### 38.2.11 看门狗与恢复

NfcService 内置看门狗机制，用于检测硬件挂起并从中恢复：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcService.java
static final int INIT_WATCHDOG_MS = 90000;   // 90s for init (firmware download)
static final int ROUTING_WATCHDOG_MS = 6000;  // 6s for routing commits
```

当 `onHwErrorReported()` 触发时，服务会执行一次完整的协议栈重启：

```java
@Override
public void onHwErrorReported() {
    if (android.nfc.Flags.nfcEventListener() && mCardEmulationManager != null) {
        mCardEmulationManager.onInternalErrorReported(
                CardEmulation.NFC_INTERNAL_ERROR_NFC_HARDWARE_ERROR);
    }
    restartStack();
}

private void restartStack() {
    // ...
    new EnableDisableTask().execute(TASK_DISABLE);
    new EnableDisableTask().execute(TASK_ENABLE);
}
```

### 38.2.12 安全 NFC

安全 NFC（Secure NFC）把 NFC 操作限制为仅在屏幕解锁状态下可用。启用后，NFCC 被配置为只在设备解锁时才响应：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcService.java
static final String PREF_SECURE_NFC_ON = "secure_nfc_on";
boolean mIsSecureNfcEnabled;
```

该特性面向这样一类场景：用户希望 NFC 支付必须解锁设备才能进行，从而防止手机放在口袋里时被盗刷。

---

## 38.3 NFC HAL

### 38.3.1 HAL 演进：从 HIDL 到 AIDL

NFC HAL 历经三代：

| 版本 | 路径 | 传输方式 |
|---------|------|-----------|
| 1.0 | `hardware/interfaces/nfc/1.0/` | HIDL |
| 1.1 | `hardware/interfaces/nfc/1.1/` | HIDL |
| 1.2 | `hardware/interfaces/nfc/1.2/` | HIDL |
| AIDL v1 | `hardware/interfaces/nfc/aidl/`（版本 1） | AIDL |
| AIDL v2 | `hardware/interfaces/nfc/aidl/`（版本 2） | AIDL |

AIDL HAL 是当前标准，其 `@VintfStability` 特性使其能够跨独立更新的系统分区工作。所有新设备都应实现 AIDL 版本。

### 38.3.2 INfc AIDL 接口

主 HAL 接口定义了 NCI 主机协议栈可以对 NFC 控制器执行的操作：

```
// Source: hardware/interfaces/nfc/aidl/aidl_api/android.hardware.nfc/current/
//         android/hardware/nfc/INfc.aidl
@VintfStability
interface INfc {
    void open(in INfcClientCallback clientCallback);
    void close(in NfcCloseType type);
    void coreInitialized();
    void factoryReset();
    NfcConfig getConfig();
    void powerCycle();
    void preDiscover();
    int write(in byte[] data);
    void setEnableVerboseLogging(in boolean enable);
    boolean isVerboseLoggingEnabled();
    NfcStatus controlGranted();
}
```

各方法的语义：

| 方法 | 用途 |
|--------|---------|
| `open()` | 给 NFCC 上电，注册数据/事件回调 |
| `close()` | 断电或置为待机（`DISABLE` 与 `HOST_SWITCHED_OFF`） |
| `coreInitialized()` | 表明 NCI CORE_INIT 已完成 |
| `write()` | 向 NFCC 发送 NCI 命令/数据 |
| `getConfig()` | 获取静态硬件配置 |
| `powerCycle()` | 对 NFCC 做硬复位 |
| `preDiscover()` | 发现流程开始前的厂商钩子 |
| `factoryReset()` | 把 NFCC 配置恢复为出厂默认值 |
| `controlGranted()` | 把独占控制权授予 HAL |

### 38.3.3 INfcClientCallback

回调接口是 HAL 向 NCI 主机回传数据与事件的方式：

```
// Source: hardware/interfaces/nfc/aidl/aidl_api/android.hardware.nfc/current/
//         android/hardware/nfc/INfcClientCallback.aidl
@VintfStability
interface INfcClientCallback {
    void sendData(in byte[] data);
    void sendEvent(in NfcEvent event, in NfcStatus status);
}
```

`sendData()` 承载来自 NFCC 的 NCI 响应与通知。`sendEvent()` 承载生命周期事件，例如 `OPEN_CPLT`、`CLOSE_CPLT` 与 `ERROR`。

### 38.3.4 NfcConfig：硬件配置

`NfcConfig` parcelable 包含 NCI 协议栈正常运行所需的静态硬件配置：

```
// Source: hardware/interfaces/nfc/aidl/aidl_api/android.hardware.nfc/current/
//         android/hardware/nfc/NfcConfig.aidl
@VintfStability
parcelable NfcConfig {
    boolean nfaPollBailOutMode;
    PresenceCheckAlgorithm presenceCheckAlgorithm;
    ProtocolDiscoveryConfig nfaProprietaryCfg;
    byte defaultOffHostRoute;
    byte defaultOffHostRouteFelica;
    byte defaultSystemCodeRoute;
    byte defaultSystemCodePowerState;
    byte defaultRoute;
    byte offHostESEPipeId;
    byte offHostSIMPipeId;
    int maxIsoDepTransceiveLength;
    byte[] hostAllowlist;
    byte[] offHostRouteUicc;
    byte[] offHostRouteEse;
    byte defaultIsoDepRoute;
    byte[] offHostSimPipeIds;
    boolean t4tNfceeEnable;
}
```

关键字段：

| 字段 | 用途 |
|-------|---------|
| `defaultRoute` | 默认 AID 路由（host=0x00，或 SE ID） |
| `defaultOffHostRoute` | 默认离主机路由（eSE ID） |
| `defaultOffHostRouteFelica` | 默认 FeliCa 路由（eSE ID） |
| `offHostRouteUicc` | UICC SE 路由 ID |
| `offHostRouteEse` | eSE 路由 ID |
| `maxIsoDepTransceiveLength` | ISO-DEP 帧最大长度 |
| `presenceCheckAlgorithm` | 检测标签是否仍存在的方式 |
| `t4tNfceeEnable` | 是否启用 Type-4 标签的 NFCEE 模拟 |

### 38.3.5 NfcEvent 与 NfcStatus 枚举

HAL 使用强类型枚举表示生命周期事件与状态码：

```
// Source: hardware/interfaces/nfc/aidl/.../NfcEvent.aidl
@Backing(type="int") @VintfStability
enum NfcEvent {
    OPEN_CPLT = 0,
    CLOSE_CPLT = 1,
    POST_INIT_CPLT = 2,
    PRE_DISCOVER_CPLT = 3,
    HCI_NETWORK_RESET = 4,
    ERROR = 5,
    REQUEST_CONTROL = 6,
    RELEASE_CONTROL = 7,
}

// Source: hardware/interfaces/nfc/aidl/.../NfcStatus.aidl
@Backing(type="int") @VintfStability
enum NfcStatus {
    OK = 0,
    FAILED = 1,
    ERR_TRANSPORT = 2,
    ERR_CMD_TIMEOUT = 3,
    REFUSED = 4,
}
```

`ERR_CMD_TIMEOUT` 状态尤为重要——它表明 NFCC 已停止响应，通常会触发 `onHwErrorReported()` 与协议栈重启。

### 38.3.6 NfcCloseType 与 PresenceCheckAlgorithm

`NfcCloseType` 控制 NFCC 的关闭方式：

```
@Backing(type="int") @VintfStability
enum NfcCloseType {
    DISABLE = 0,           // User explicitly disabled NFC
    HOST_SWITCHED_OFF = 1, // Device is shutting down
}
```

`PresenceCheckAlgorithm` 控制 NCI 协议栈如何验证标签仍在范围内：

```
@Backing(type="byte") @VintfStability
enum PresenceCheckAlgorithm {
    DEFAULT = 0,      // Let the stack choose
    I_BLOCK = 1,      // Send ISO-DEP I-Block
    ISO_DEP_NAK = 2,  // Send ISO-DEP NAK
}
```

### 38.3.7 ProtocolDiscoveryConfig

`ProtocolDiscoveryConfig` parcelable 控制轮询期间要发现哪些 NFC 协议。它映射为 NCI 协议栈在 NFCC 中配置的 NCI 射频发现参数。

### 38.3.8 HAL 的 open-write-close 生命周期

HAL 遵循严格的生命周期：

```mermaid
stateDiagram-v2
    [*] --> Closed
    Closed --> Opening: open 回调
    Opening --> Opened: OPEN_CPLT 事件
    Opened --> CoreInit: coreInitialized
    CoreInit --> Ready: POST_INIT_CPLT 事件
    Ready --> PreDiscover: preDiscover
    PreDiscover --> Discovering: PRE_DISCOVER_CPLT 事件
    Ready --> Writing: write nciCommand
    Writing --> Ready: 命令已确认
    Ready --> Closing: close type
    Closing --> Closed: CLOSE_CPLT 事件
    Ready --> PowerCycle: powerCycle
    PowerCycle --> Closed: 循环完成
```

关键不变量是：`write()` 只能在 `open()` 完成（以 `OPEN_CPLT` 为信号）之后调用。`coreInitialized()` 调用表明主机已完成其 NCI CORE_INIT 序列，HAL 此时可以执行任何初始化后的厂商特定操作。

### 38.3.9 NCI 数据穿过 HAL 的流向

所有 NCI 协议数据经由两条通路流动：

```mermaid
graph LR
    subgraph "主机到 NFCC"
        H2N1["libnfc-nci"] -->|"NCI 命令字节"| H2N2["INfc.write()"]
        H2N2 --> H2N3["NFCC 硬件"]
    end

    subgraph "NFCC 到主机"
        N2H1["NFCC 硬件"] -->|"NCI 响应/通知"| N2H2["INfcClientCallback.sendData()"]
        N2H2 --> N2H3["libnfc-nci"]
    end
```

HAL 实现负责成帧。部分控制器使用 SPI、I2C 或 UART 作为物理传输，但这些细节都被 HAL 抽象层隐藏。

### 38.3.10 libnfc-nci：NCI 协议栈

`libnfc-nci` 库（`packages/modules/Nfc/libnfc-nci/`）用 C 实现 NCI 协议。它负责管理：

- NCI 命令组装与响应解析
- 射频发现状态机
- 标签激活与数据交换
- NFCEE（安全元件）管理
- 监听模式（卡模拟）协议处理

该库的结构：

```
libnfc-nci/
  src/
    nfc/          # Core NFC logic
    nfa/          # NFA (NFC Adaptation) layer
    gki/          # Generic Kernel Interface (threading)
    adaptation/   # HAL adaptation layer
    include/      # Headers
  conf/           # Configuration files
```

### 38.3.11 NFC HAL 的 VTS 测试

NFC HAL 的 VTS（Vendor Test Suite，厂商测试套件）测试用于确保一致性：

```
hardware/interfaces/nfc/aidl/vts/
```

这些测试验证：

- `open()` / `close()` 生命周期
- `write()` 返回正确的字节数
- `getConfig()` 返回有效配置
- 事件与数据的回调送达
- `powerCycle()` 正确复位控制器

---

## 38.4 NDEF：NFC 数据交换格式

### 38.4.1 什么是 NDEF

NDEF（NFC Data Exchange Format，NFC 数据交换格式）是 NFC Forum 标准化的轻量级二进制格式，用于编码结构化载荷。它与传输无关——虽然是为 NFC 设计的，但该格式本身可用于任何通道。

NDEF 有两个主要概念：

- **NdefMessage** —— 容纳一条或多条记录的容器
- **NdefRecord** —— 单个带类型的载荷（URI、文本、MIME 数据等）

Android 用 `android.nfc.NdefMessage` 与 `android.nfc.NdefRecord` 表示它们。

### 38.4.2 NdefMessage：容器

```java
// Source: packages/modules/Nfc/framework/java/android/nfc/NdefMessage.java
public final class NdefMessage implements Parcelable {
    private final NdefRecord[] mRecords;

    // Construct from raw bytes (e.g., read from tag)
    public NdefMessage(byte[] data) throws FormatException { ... }

    // Construct from records
    public NdefMessage(NdefRecord[] records) { ... }
    public NdefMessage(NdefRecord record, NdefRecord... records) { ... }

    // Get all records
    public NdefRecord[] getRecords() { return mRecords; }

    // Serialize to bytes (e.g., for writing to tag)
    public byte[] toByteArray() { ... }
}
```

消息中的第一条记录具有特殊重要性——标签分发系统依据它决定启动哪个应用。

### 38.4.3 NdefRecord：载荷单元

每条 `NdefRecord` 承载一个带类型的载荷：

```java
// Source: packages/modules/Nfc/framework/java/android/nfc/NdefRecord.java
public final class NdefRecord implements Parcelable {
    // Constructor
    public NdefRecord(short tnf, byte[] type, byte[] id, byte[] payload) { ... }

    // Factory methods
    public static NdefRecord createUri(Uri uri) { ... }
    public static NdefRecord createUri(String uriString) { ... }
    public static NdefRecord createMime(String mimeType, byte[] mimeData) { ... }
    public static NdefRecord createExternal(
            String domain, String type, byte[] data) { ... }
    public static NdefRecord createTextRecord(
            String languageCode, String text) { ... }
    public static NdefRecord createApplicationRecord(
            String packageName) { ... }

    // Accessors
    public short getTnf() { ... }
    public byte[] getType() { ... }
    public byte[] getId() { ... }
    public byte[] getPayload() { ... }

    // Convenience converters
    public Uri toUri() { ... }
    public String toMimeType() { ... }
}
```

### 38.4.4 TNF：类型名格式

3 位的 TNF 字段规定了 type 字段应如何解释：

```java
// Source: packages/modules/Nfc/framework/java/android/nfc/NdefRecord.java
public static final short TNF_EMPTY = 0x00;
public static final short TNF_WELL_KNOWN = 0x01;
public static final short TNF_MIME_MEDIA = 0x02;
public static final short TNF_ABSOLUTE_URI = 0x03;
public static final short TNF_EXTERNAL_TYPE = 0x04;
public static final short TNF_UNKNOWN = 0x05;
public static final short TNF_UNCHANGED = 0x06;
```

| TNF | 名称 | Type 字段含义 |
|-----|------|-------------------|
| 0x00 | Empty（空） | 无类型、无载荷 |
| 0x01 | Well-Known（众所周知） | NFC Forum RTD 类型（URI、Text、Smart Poster） |
| 0x02 | MIME Media | RFC 2046 MIME 类型字符串 |
| 0x03 | Absolute URI | RFC 3986 绝对 URI |
| 0x04 | External Type | 反向域名自定义类型 |
| 0x05 | Unknown | 未知类型（类似 application/octet-stream） |
| 0x06 | Unchanged | 分段续传块（不对应用暴露） |

### 38.4.5 众所周知的 RTD 类型

NFC Forum 为常见类型定义了记录类型定义（RTD）常量：

```java
// Source: packages/modules/Nfc/framework/java/android/nfc/NdefRecord.java
public static final byte[] RTD_TEXT = {0x54};              // "T"
public static final byte[] RTD_URI = {0x55};               // "U"
public static final byte[] RTD_SMART_POSTER = {0x53, 0x70}; // "Sp"
public static final byte[] RTD_ALTERNATIVE_CARRIER = {0x61, 0x63}; // "ac"
public static final byte[] RTD_HANDOVER_CARRIER = {0x48, 0x63};    // "Hc"
public static final byte[] RTD_HANDOVER_REQUEST = {0x48, 0x72};    // "Hr"
public static final byte[] RTD_HANDOVER_SELECT = {0x48, 0x73};     // "Hs"
```

```mermaid
graph TD
    WK["TNF_WELL_KNOWN (0x01)"]
    WK --> URI["RTD_URI 'U'\n带前缀压缩的 URL"]
    WK --> TEXT["RTD_TEXT 'T'\n人类可读文本"]
    WK --> SP["RTD_SMART_POSTER 'Sp'\nURI + 元数据"]
    WK --> AC["RTD_ALTERNATIVE_CARRIER 'ac'\n切换协商"]
    WK --> HC["RTD_HANDOVER_CARRIER 'Hc'\n载体描述"]
    WK --> HR["RTD_HANDOVER_REQUEST 'Hr'\n切换请求"]
    WK --> HS["RTD_HANDOVER_SELECT 'Hs'\n切换选择"]
```

### 38.4.6 URI 记录编码与前缀压缩

URI 记录使用一套高效的前缀压缩方案。载荷的第一个字节是前缀索引：

| 索引 | 前缀 | 索引 | 前缀 |
|-------|--------|-------|--------|
| 0x00 | （无） | 0x01 | `http://www.` |
| 0x02 | `https://www.` | 0x03 | `http://` |
| 0x04 | `https://` | 0x05 | `tel:` |
| 0x06 | `mailto:` | 0x07 | `ftp://anonymous:anonymous@` |
| 0x08 | `ftp://ftp.` | 0x09 | `ftps://` |
| 0x0A | `sftp://` | 0x0B | `smb://` |
| 0x0C | `nfs://` | 0x0D | `ftp://` |
| 0x0E | `dav://` | 0x0F | `news:` |
| 0x10 | `telnet://` | 0x11 | `imap:` |
| 0x12 | `rtsp://` | 0x13 | `urn:` |
| 0x14 | `pop:` | 0x15 | `sip:` |
| 0x16 | `sips:` | 0x17 | `tftp:` |
| 0x18 | `btspp://` | 0x19 | `btl2cap://` |
| 0x1A | `btgoep://` | 0x1B | `tcpobex://` |
| 0x1C | `irdaobex://` | 0x1D | `file://` |
| 0x1E | `urn:epc:id:` | 0x1F | `urn:epc:tag:` |
| 0x20 | `urn:epc:pat:` | 0x21 | `urn:epc:raw:` |
| 0x22 | `urn:epc:` | 0x23 | `urn:nfc:` |

例如，`https://android.com` 会被编码为 `0x04` + `android.com`（12 字节，而用未压缩的 `0x00` + `https://android.com` 载荷则需要 20 字节）。`createUri()` 工厂方法会自动完成这一处理。

### 38.4.7 文本记录编码

文本记录（`RTD_TEXT`）编码包含：

- 状态字节：第 7 位 = 编码方式（0=UTF-8，1=UTF-16），第 5–0 位 = 语言代码长度
- 语言代码（IANA 格式，例如 "en"、"ja"）
- 文本载荷

```
Byte layout:
[Status] [Language Code] [Text]
  1 byte   N bytes        M bytes

Status byte:
  Bit 7: 0 = UTF-8, 1 = UTF-16
  Bit 6: Reserved
  Bits 5-0: Language code length
```

### 38.4.8 智能海报记录

智能海报（`RTD_SMART_POSTER`）是一个嵌套的 NDEF 消息，其中包含多条记录，共同描述一张“海报”：

```mermaid
graph TD
    SP["智能海报记录\nTNF=0x01, Type='Sp'"]
    SP --> URI["URI 记录\n（必需）"]
    SP --> TITLE["标题记录\nRTD_TEXT（可选）"]
    SP --> ACTION["动作记录\n（可选：open/save/edit）"]
    SP --> ICON["图标记录\nMIME 图片（可选）"]
    SP --> SIZE["大小记录\n（可选）"]
    SP --> TYPE["类型记录\nMIME 类型（可选）"]
```

智能海报记录的载荷本身就是一个合法的 NDEF 消息。Android 标签分发系统会解开智能海报，并依据其中内嵌的 URI 进行分发。

### 38.4.9 MIME 类型记录

MIME 记录（`TNF_MIME_MEDIA`）承载以标准 MIME 类型标注的任意二进制数据：

```java
// Create a MIME record
NdefRecord mimeRecord = NdefRecord.createMime(
    "application/vnd.example.myapp",
    myPayloadBytes
);
```

标签分发系统使用 MIME 类型做 Intent 匹配，从而允许应用在清单中注册特定的 MIME 类型。

### 38.4.10 外部类型记录与 Android 应用记录

外部类型记录（`TNF_EXTERNAL_TYPE`）用反向域名命名自定义类型：

```java
NdefRecord extRecord = NdefRecord.createExternal(
    "example.com",        // domain
    "mytype",             // type
    myPayloadBytes        // data
);
// Results in type: "example.com:mytype"
```

**Android 应用记录（AAR）**是一种特殊的外部类型，用于强制把标签分发给指定包：

```java
NdefRecord aar = NdefRecord.createApplicationRecord("com.example.myapp");
// TNF = TNF_EXTERNAL_TYPE
// Type = "android.com:pkg"
// Payload = "com.example.myapp"
```

当 NDEF 消息中存在 AAR 时，Android 保证由指定应用处理该标签。若该应用未安装，则会打开 Play Store 引导安装。

### 38.4.11 空口上的 NDEF 二进制格式

NDEF 记录头的二进制格式：

```
Byte 0 (flags):
  Bit 7 (MB): Message Begin -- first record in message
  Bit 6 (ME): Message End -- last record in message
  Bit 5 (CF): Chunk Flag -- record is a chunk
  Bit 4 (SR): Short Record -- payload length is 1 byte
  Bit 3 (IL): ID Length present
  Bits 2-0: TNF (Type Name Format)

Byte 1: TYPE_LENGTH
Byte 2: PAYLOAD_LENGTH (1 byte if SR=1, 4 bytes if SR=0)
Byte 3: ID_LENGTH (only if IL=1)
Bytes N: TYPE
Bytes N: ID (only if IL=1)
Bytes N: PAYLOAD
```

```mermaid
graph LR
    subgraph "NDEF 消息"
        R1["记录 1\nMB=1, ME=0"]
        R2["记录 2\nMB=0, ME=0"]
        R3["记录 3\nMB=0, ME=1"]
    end
    R1 --> R2 --> R3

    subgraph "记录结构"
        F["标志位\n（1 字节）"]
        TL["类型长度\n（1 字节）"]
        PL["载荷长度\n（1 或 4 字节）"]
        IL["ID 长度\n（0 或 1 字节）"]
        T["类型\n（N 字节）"]
        I["ID\n（N 字节）"]
        P["载荷\n（N 字节）"]
    end
    F --> TL --> PL --> IL --> T --> I --> P
```

### 38.4.12 在代码中创建 NDEF 记录

常见的 NDEF 构造方式：

```java
// URI record
NdefRecord uriRecord = NdefRecord.createUri("https://android.com");

// Text record
NdefRecord textRecord = NdefRecord.createTextRecord("en", "Hello NFC");

// MIME record
NdefRecord mimeRecord = NdefRecord.createMime(
    "application/json",
    "{\"key\":\"value\"}".getBytes(StandardCharsets.UTF_8)
);

// Android Application Record (AAR)
NdefRecord aarRecord = NdefRecord.createApplicationRecord("com.example.app");

// Compose a message with URI + AAR
NdefMessage message = new NdefMessage(uriRecord, aarRecord);

// Serialize for writing to tag
byte[] rawBytes = message.toByteArray();
```

---

## 38.5 标签分发系统

### 38.5.1 分发优先级链

Android 的标签分发系统遵循严格的优先级链，以决定由哪个应用处理已发现的标签：

```mermaid
graph TD
    TAG["发现标签"]
    FD{"前台分发<br/>是否激活？"}
    NDEF{"是否有 NDEF<br/>消息？"}
    NDEF_MATCH{"应用是否匹配<br/>ACTION_NDEF_<br/>DISCOVERED？"}
    TECH_MATCH{"应用是否匹配<br/>ACTION_TECH_<br/>DISCOVERED？"}
    TAG_MATCH{"应用是否匹配<br/>ACTION_TAG_<br/>DISCOVERED？"}
    FD_DELIVER["交付给前台<br/>Activity"]
    NDEF_DELIVER["启动匹配 NDEF<br/>的 Activity"]
    TECH_DELIVER["启动匹配 TECH<br/>的 Activity"]
    TAG_DELIVER["启动匹配 TAG<br/>的 Activity"]
    DROP["未找到处理者<br/>（标签被忽略）"]

    TAG --> FD
    FD -->|是| FD_DELIVER
    FD -->|否| NDEF
    NDEF -->|是| NDEF_MATCH
    NDEF -->|否| TECH_MATCH
    NDEF_MATCH -->|是| NDEF_DELIVER
    NDEF_MATCH -->|否| TECH_MATCH
    TECH_MATCH -->|是| TECH_DELIVER
    TECH_MATCH -->|否| TAG_MATCH
    TAG_MATCH -->|是| TAG_DELIVER
    TAG_MATCH -->|否| DROP
```

### 38.5.2 ACTION_NDEF_DISCOVERED：最高优先级

`ACTION_NDEF_DISCOVERED` 是最具体的一类 Intent。系统检查第一个 `NdefMessage` 中的第一条 `NdefRecord`，并构造带有以下信息的 Intent：

- **URI 数据**：若该记录是 URI 或智能海报
- **MIME 类型**：若该记录是 MIME 类型记录

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcDispatcher.java
public Intent setNdefIntent() {
    intent.setAction(NfcAdapter.ACTION_NDEF_DISCOVERED);
    if (ndefUri != null) {
        intent.setData(ndefUri);
        return intent;
    } else if (ndefMimeType != null) {
        intent.setType(ndefMimeType);
        return intent;
    }
    return null;
}
```

Activity 通过 Intent filter 注册，以捕获特定 URI 或 MIME 类型：

```xml
<activity android:name=".NfcHandler">
    <intent-filter>
        <action android:name="android.nfc.action.NDEF_DISCOVERED" />
        <category android:name="android.intent.category.DEFAULT" />
        <data android:scheme="https" android:host="example.com" />
    </intent-filter>
</activity>
```

### 38.5.3 ACTION_TECH_DISCOVERED：技术匹配

若没有 Activity 处理 `ACTION_NDEF_DISCOVERED`，系统会回退到 `ACTION_TECH_DISCOVERED`。该 Intent 依据标签所支持的技术进行匹配，而不看载荷内容。

Activity 通过 `meta-data` 元素声明兴趣，指向一个 XML 资源：

```xml
<!-- AndroidManifest.xml -->
<activity android:name=".TechHandler">
    <intent-filter>
        <action android:name="android.nfc.action.TECH_DISCOVERED" />
    </intent-filter>
    <meta-data android:name="android.nfc.action.TECH_DISCOVERED"
               android:resource="@xml/nfc_tech_filter" />
</activity>
```

过滤 XML 在单个 `tech-list` 内部使用“与”关系，在多个 `tech-list` 组之间使用“或”关系：

```xml
<!-- res/xml/nfc_tech_filter.xml -->
<resources>
    <!-- Match any tag with NfcA AND Ndef -->
    <tech-list>
        <tech>android.nfc.tech.NfcA</tech>
        <tech>android.nfc.tech.Ndef</tech>
    </tech-list>

    <!-- OR match any tag with NfcF -->
    <tech-list>
        <tech>android.nfc.tech.NfcF</tech>
    </tech-list>
</resources>
```

匹配逻辑：只要任一 `tech-list` 是标签技术列表的**子集**，该标签即匹配成功。

### 38.5.4 ACTION_TAG_DISCOVERED：兜底回退

`ACTION_TAG_DISCOVERED` 是优先级最低的兜底项。它匹配任何 NFC 标签，不论内容或技术。这是最后手段——设计良好的应用应使用更具体的 Intent：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcDispatcher.java
public Intent setTagIntent() {
    intent.setData(null);
    intent.setType(null);
    intent.setAction(NfcAdapter.ACTION_TAG_DISCOVERED);
    return intent;
}
```

### 38.5.5 NfcDispatcher：分发引擎

`NfcDispatcher` 负责编排整条分发链：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcDispatcher.java
class NfcDispatcher {
    static final int DISPATCH_SUCCESS = 1;
    static final int DISPATCH_FAIL = 2;
    static final int DISPATCH_UNLOCK = 3;

    private PendingIntent mOverrideIntent;         // foreground dispatch
    private IntentFilter[] mOverrideFilters;        // foreground dispatch filters
    private String[][] mOverrideTechLists;          // foreground dispatch techs
    private final RegisteredComponentCache mTechListFilters; // tech discovery cache
    ...
}
```

分发流程：

1. 检查前台分发覆盖（`mOverrideIntent`）
2. 在 `tryNdef()` 内：构造 `ACTION_NDEF_DISCOVERED` Intent（URI 或 MIME 类型），然后尝试 AAR/OEM 指定的目标包
3. 若 NDEF URI 是 http(s) 网页链接，则把 Intent 换成 `ACTION_VIEW` 并提示用户（若已有接收方则立即返回）
4. 否则为 `ACTION_NDEF_DISCOVERED` 解析可处理的 Activity
5. 尝试带技术匹配的 `ACTION_TECH_DISCOVERED`
6. 尝试 `ACTION_TAG_DISCOVERED` 作为最终兜底
7. 若无任何匹配则返回 `DISPATCH_FAIL`

### 38.5.6 DispatchInfo：构造 Intent

`DispatchInfo` 是一个辅助类，用于构造带齐所有必要 extra 的分发 Intent：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcDispatcher.java
static class DispatchInfo {
    public final Intent intent;
    public final Tag tag;
    final Uri ndefUri;
    final String ndefMimeType;

    DispatchInfo(Context context, NfcInjector nfcInjector,
            Tag tag, NdefMessage message) {
        intent = new Intent();
        intent.putExtra(NfcAdapter.EXTRA_TAG, tag);
        intent.putExtra(NfcAdapter.EXTRA_ID, tag.getId());
        if (message != null) {
            intent.putExtra(NfcAdapter.EXTRA_NDEF_MESSAGES,
                    new NdefMessage[] {message});
            ndefUri = message.getRecords()[0].toUri();
            ndefMimeType = message.getRecords()[0].toMimeType();
        } else {
            ndefUri = null;
            ndefMimeType = null;
        }
        ...
    }
}
```

提供给接收 Activity 的 Intent extra：

| Extra | 类型 | 用途 |
|-------|------|---------|
| `EXTRA_TAG` | `Tag` | 已发现的标签对象 |
| `EXTRA_ID` | `byte[]` | 标签 UID |
| `EXTRA_NDEF_MESSAGES` | `NdefMessage[]` | NDEF 消息（如有） |

### 38.5.7 前台分发覆盖

前台分发使当前可见的 Activity 获得标签事件的最高优先级，绕过正常分发链：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcDispatcher.java
public synchronized void setForegroundDispatch(PendingIntent intent,
        IntentFilter[] filters, String[][] techLists) {
    mOverrideIntent = intent;
    mOverrideFilters = filters;
    mOverrideTechLists = techLists;
    ...
}
```

当前台分发处于激活状态且发现标签时：

1. 若 `mOverrideFilters` 为 null 或标签匹配某个过滤器，则投递到 `mOverrideIntent`
2. 该标签**不会**再经过正常分发链

若 Activity 退到后台，分发会通过 `ForegroundUtils.Callback` 自动清除：

```java
class ForegroundCallbackImpl implements ForegroundUtils.Callback {
    @Override
    public void onUidToBackground(int uid) {
        synchronized (NfcDispatcher.this) {
            if (mForegroundUid == uid) {
                setForegroundDispatch(null, null, null);
            }
        }
    }
}
```

### 38.5.8 技术列表 XML 过滤格式

技术列表 XML 文件由 `RegisteredComponentCache` 解析，后者缓存所有带 `ACTION_TECH_DISCOVERED` 过滤器的 Activity：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcDispatcher.java
private final RegisteredComponentCache mTechListFilters;

// Initialized with:
mTechListFilters = new RegisteredComponentCache(mContext,
        NfcAdapter.ACTION_TECH_DISCOVERED,
        NfcAdapter.ACTION_TECH_DISCOVERED);
```

可用于过滤器的技术类：

| 类 | ISO 标准 |
|-------|-------------|
| `android.nfc.tech.NfcA` | ISO 14443-3A |
| `android.nfc.tech.NfcB` | ISO 14443-3B |
| `android.nfc.tech.NfcF` | JIS X 6319-4（FeliCa） |
| `android.nfc.tech.NfcV` | ISO 15693 |
| `android.nfc.tech.IsoDep` | ISO 14443-4 |
| `android.nfc.tech.Ndef` | 已按 NDEF 格式化 |
| `android.nfc.tech.NdefFormatable` | 可被格式化为 NDEF |
| `android.nfc.tech.MifareClassic` | NXP MIFARE Classic |
| `android.nfc.tech.MifareUltralight` | NXP MIFARE Ultralight |
| `android.nfc.tech.NfcBarcode` | Kovio/Thinfilm 条码 |

### 38.5.9 标签应用偏好列表

Android 支持按用户维护的偏好列表，用于控制哪些应用接收标签事件。用户可以让特定应用不再接收 NFC 标签分发：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcService.java
HashMap<Integer, HashMap<String, Boolean>> mTagAppPrefList =
        new HashMap<Integer, HashMap<String, Boolean>>();
```

分发引擎在投递 Intent 前会检查该列表：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcDispatcher.java
List<ResolveInfo> checkPrefList(List<ResolveInfo> activities, int userId) {
    // ...
    Map<String, Boolean> preflist =
            mNfcAdapter.getTagIntentAppPreferenceForUser(userId);
    if (preflist.containsKey(pkgName)) {
        if (!preflist.get(pkgName)) {
            // Muted -- remove from candidate list
            filtered.remove(resolveInfo);
        }
    }
    // ...
}
```

### 38.5.10 多用户分发

标签分发遵循 Android 的多用户模型。分发器先尝试当前前台用户，再回退到其他活动用户档案：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcDispatcher.java
boolean tryStartActivity() {
    // Try current user
    List<ResolveInfo> activities = queryNfcIntentActivitiesAsUser(
            packageManager, intent,
            UserHandle.of(ActivityManager.getCurrentUser()));
    // ...
    if (activities.size() > 0) {
        context.startActivityAsUser(rootIntent, UserHandle.CURRENT);
        return true;
    }
    // Try other active users
    List<UserHandle> userHandles = getCurrentActiveUserHandles();
    // ...
}
```

### 38.5.11 标签 Intent 的清单注册

一份完整的、用于处理 NFC 标签的清单注册示例：

```xml
<manifest ...>
    <uses-permission android:name="android.permission.NFC" />
    <uses-feature android:name="android.hardware.nfc"
                  android:required="true" />

    <application ...>
        <!-- Handle NDEF URI tags -->
        <activity android:name=".NdefUriActivity"
                  android:exported="true">
            <intent-filter>
                <action android:name="android.nfc.action.NDEF_DISCOVERED" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:scheme="https"
                      android:host="example.com"
                      android:pathPrefix="/nfc/" />
            </intent-filter>
        </activity>

        <!-- Handle NDEF MIME tags -->
        <activity android:name=".NdefMimeActivity"
                  android:exported="true">
            <intent-filter>
                <action android:name="android.nfc.action.NDEF_DISCOVERED" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="application/vnd.example.mydata" />
            </intent-filter>
        </activity>

        <!-- Handle specific tech tags -->
        <activity android:name=".TechActivity"
                  android:exported="true">
            <intent-filter>
                <action android:name="android.nfc.action.TECH_DISCOVERED" />
            </intent-filter>
            <meta-data android:name="android.nfc.action.TECH_DISCOVERED"
                       android:resource="@xml/tech_filter" />
        </activity>

        <!-- Catch-all for any tag -->
        <activity android:name=".TagCatchAllActivity"
                  android:exported="true">
            <intent-filter>
                <action android:name="android.nfc.action.TAG_DISCOVERED" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```

### 38.5.12 标签分发的常见陷阱

1. **只注册 `ACTION_TAG_DISCOVERED`** —— 这只在没有更具体的处理者时才能捕获标签。应优先使用 `ACTION_NDEF_DISCOVERED` 或 `ACTION_TECH_DISCOVERED`。

2. **忘记 `android:exported="true"`** —— 标签分发使用隐式 Intent，而在 Android 12 及以上要求 Activity 显式导出。

3. **未处理多记录消息** —— 分发系统只检查第一条记录。其余记录（如 AAR）必须显式处理。

4. **缺少 DEFAULT category** —— `ACTION_NDEF_DISCOVERED` 与 `ACTION_TAG_DISCOVERED` 要求在 Intent filter 中声明 `CATEGORY_DEFAULT`。

5. **未使用前台分发** —— 对于需要确保获得标签访问权的应用（例如标签写入器），前台分发可避免出现 Activity 选择器。

### 38.5.13 内置的标签查看器应用

AOSP 在分发链末端附带了一个小型参考处理者，代码位于 `packages/apps/Tag/`（包名 `com.android.apps.tag`）。它是一个特权应用，只有一个 Activity，即 `TagViewer`，在没有更具体的处理者认领时显示所扫描 NDEF 标签的内容。

它的注册方式正是 38.5.1 中兜底模式的实践示例。该 Activity 设置 `android:priority="-10"`，因此任何其他匹配的处理者都会在选择器排序中胜出。它基于 `TECH_DISCOVERED` 过滤，技术列表只含单一技术 `android.nfc.tech.Ndef`（`packages/apps/Tag/res/xml/filter_nfc.xml`）。它另外还有针对 `vnd.android.cursor.item/ndef_msg` MIME 类型的 `VIEW` 过滤器：

```xml
<!-- Source: packages/apps/Tag/AndroidManifest.xml -->
<activity android:name="TagViewer"
    android:priority="-10"
    android:permission="android.permission.DISPATCH_NFC_MESSAGE">
    <intent-filter>
        <action android:name="android.nfc.action.TECH_DISCOVERED"/>
    </intent-filter>
    <meta-data android:name="android.nfc.action.TECH_DISCOVERED"
        android:resource="@xml/filter_nfc"/>
</activity>
```

`TagViewer.resolveIntent()` 读取 `NfcDispatcher` 打包进 Intent 的 `EXTRA_NDEF_MESSAGES` 数组（见 38.5.6），并把第一条消息交给 `NdefMessageParser`（`packages/apps/Tag/src/com/android/apps/tag/message/`）。解析器把每条记录归入某种带类型的渲染器：智能海报、URI、文本、图片、vCard、通用 MIME，或作为未知记录的兜底渲染。每个渲染器各自填充自己的视图，因此扫描到的标签会以可读的行呈现，而不是原始字节。

该应用只解析标签上的第一条 NDEF 消息，并且只覆盖上述记录类型，仅此而已。它是一个用于手工检查标签的查看器，本身不承载任何框架逻辑。把标签投递给它的分发机制，见 38.4 与 38.5 其余小节。

---

## 38.6 主机卡模拟（HCE）

### 38.6.1 什么是 HCE

主机卡模拟（Host Card Emulation，HCE）使 Android 设备能够模拟 ISO-DEP（ISO 14443-4）非接触智能卡。APDU 交换由应用处理器处理，而非由专用安全元件处理。这使以下场景成为可能：

- 非接触支付（Google Wallet、银行应用）
- 会员卡
- 交通卡（在支持的地区）
- 门禁卡

HCE 于 Android 4.4（KitKat，API 19）引入。

```mermaid
graph LR
    subgraph "外部读取器"
        R["POS 终端<br/>或读取器"]
    end

    subgraph "Android 设备"
        subgraph "NFC 控制器"
            NFCC["NFCC\n（监听模式）"]
        end
        subgraph "主机（AP）"
            HEM["HostEmulationManager"]
            SVC["HostApduService\n（你的应用）"]
        end
        subgraph "安全元件"
            SE["eSE / UICC"]
        end
    end

    R <-->|"射频（ISO-DEP）"| NFCC
    NFCC <-->|"NCI"| HEM
    HEM <-->|"APDU"| SVC
    NFCC <-->|"SWP"| SE

    style HEM fill:#f9f,stroke:#333
    style SVC fill:#bbf,stroke:#333
```

### 38.6.2 架构：HostApduService

应用通过继承 `HostApduService` 来实现 HCE：

```java
public class MyPaymentService extends HostApduService {
    @Override
    public byte[] processCommandApdu(byte[] apdu, Bundle extras) {
        // Process the SELECT APDU or subsequent commands
        if (isSelectAid(apdu)) {
            return SELECT_OK_SW;
        }
        // Process transaction APDUs
        return processTransaction(apdu);
    }

    @Override
    public void onDeactivated(int reason) {
        // Clean up when the reader moves away
    }
}
```

该服务在清单中以 AID 组的形式声明：

```xml
<service android:name=".MyPaymentService"
         android:exported="true"
         android:permission="android.permission.BIND_NFC_SERVICE">
    <intent-filter>
        <action android:name="android.nfc.cardemulation.action.HOST_APDU_SERVICE" />
    </intent-filter>
    <meta-data android:name="android.nfc.cardemulation.host_apdu_service"
               android:resource="@xml/apdu_service" />
</service>
```

### 38.6.3 CardEmulationManager：总协调者

`CardEmulationManager` 是所有卡模拟功能的核心协调者：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/cardemulation/
//         CardEmulationManager.java
public class CardEmulationManager implements
        RegisteredServicesCache.Callback,
        RegisteredNfcFServicesCache.Callback,
        PreferredServices.Callback,
        EnabledNfcFServices.Callback,
        WalletRoleObserver.Callback {

    final RegisteredAidCache mAidCache;
    final RegisteredT3tIdentifiersCache mT3tIdentifiersCache;
    final RegisteredServicesCache mServiceCache;
    final RegisteredNfcFServicesCache mNfcFServicesCache;
    final HostEmulationManager mHostEmulationManager;
    final HostNfcFEmulationManager mHostNfcFEmulationManager;
    final PreferredServices mPreferredServices;
    final WalletRoleObserver mWalletRoleObserver;
    ...
}
```

它管理八个子系统（第九个节点 `AidRoutingManager` 由 `RegisteredAidCache` 而非 `CardEmulationManager` 直接持有）：

```mermaid
graph TD
    CEM["CardEmulationManager"]
    CEM --> RSC["RegisteredServicesCache\n(HCE 服务)"]
    CEM --> RNFSC["RegisteredNfcFServicesCache\n(HCE-F 服务)"]
    CEM --> RAC["RegisteredAidCache\n(AID 解析)"]
    CEM --> RT3T["RegisteredT3tIdentifiersCache\n(T3T 标识符)"]
    CEM --> HEM["HostEmulationManager\n(APDU 处理)"]
    CEM --> HNFEM["HostNfcFEmulationManager\n(NFC-F 处理)"]
    CEM --> PS["PreferredServices\n(默认支付)"]
    CEM --> WRO["WalletRoleObserver\n(钱包角色)"]
    RAC --> ARM["AidRoutingManager\n(NFCC 路由)"]
```

### 38.6.4 AID 注册与路由

AID（应用标识符）路由决定由哪个服务处理哪个卡应用。AID 遵循 ISO 7816-4，并以十六进制编码：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/cardemulation/
//         CardEmulationManager.java
static final int MINIMUM_AID_LENGTH = 5;
static final int SELECT_APDU_HDR_LENGTH = 5;

// NDEF Tag application AIDs
static final byte[] NDEF_AID_V1 =
        new byte[] {(byte)0xd2, 0x76, 0x00, 0x00, (byte)0x85, 0x01, 0x00};
static final byte[] NDEF_AID_V2 =
        new byte[] {(byte)0xd2, 0x76, 0x00, 0x00, (byte)0x85, 0x01, 0x01};

// Select APDU header: CLA INS P1 P2
static final byte[] SELECT_AID_HDR = new byte[] {0x00, (byte)0xa4, 0x04, 0x00};
```

NFCC 中的路由表把 AID 映射到目的地：

| 路由 ID | 目的地 |
|----------|-------------|
| 0x00 | 主机（应用处理器） |
| 0x01-0xFF | 离主机（eSE、UICC 等） |

### 38.6.5 AID 组与类别

服务在 XML 中声明 AID 组，每组归属于某个类别：

```xml
<!-- res/xml/apdu_service.xml -->
<host-apdu-service xmlns:android="http://schemas.android.com/apk/res/android"
    android:description="@string/service_description"
    android:requireDeviceUnlock="false"
    android:apduServiceBanner="@drawable/banner">

    <!-- Payment AID group -->
    <aid-group android:description="@string/payment"
               android:category="payment">
        <aid-filter android:name="A0000000041010" />  <!-- Visa -->
        <aid-filter android:name="A0000000031010" />  <!-- Mastercard -->
    </aid-group>

    <!-- Other AID group -->
    <aid-group android:description="@string/loyalty"
               android:category="other">
        <aid-filter android:name="F0010203040506" />
    </aid-group>
</host-apdu-service>
```

两个 AID 类别：

- `payment` —— 同一时间只能有一个支付服务生效（即默认支付服务）
- `other` —— 多个服务可以注册相同的 AID；若发生冲突，会提示用户选择

### 38.6.6 HostEmulationManager：APDU 处理

`HostEmulationManager` 管理 NFC 控制器与已绑定 `HostApduService` 之间的 APDU 交换：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/cardemulation/
//         HostEmulationManager.java
public class HostEmulationManager {
    static final int STATE_IDLE = 0;
    static final int STATE_W4_SELECT = 1;
    static final int STATE_W4_SERVICE = 2;
    static final int STATE_W4_DEACTIVATE = 3;
    static final int STATE_XFER = 4;
    static final int STATE_POLLING_LOOP = 5;

    static final byte INSTR_SELECT = (byte)0xA4;

    // Standard responses
    static final byte[] AID_NOT_FOUND = {0x6A, (byte)0x82};
    static final byte[] UNKNOWN_ERROR = {0x6F, 0x00};

    // Android-specific HCE detection AID
    static final String ANDROID_HCE_AID = "A000000476416E64726F6964484345";
    static final byte[] ANDROID_HCE_RESPONSE =
            {0x14, (byte)0x81, 0x00, 0x00, (byte)0x90, 0x00};
    ...
}
```

### 38.6.7 HCE 状态机

HCE 状态机处理单次卡模拟事务的生命周期：

```mermaid
stateDiagram-v2
    [*] --> IDLE
    IDLE --> W4_SELECT: onHostCardEmulationActivated
    W4_SELECT --> W4_SERVICE: 收到 SELECT APDU，<br/>解析 AID
    W4_SERVICE --> XFER: 服务已绑定，<br/>转发 APDU
    XFER --> XFER: 后续 APDU
    XFER --> W4_SELECT: 新的 SELECT APDU，<br/>不同 AID
    XFER --> IDLE: onHostCardEmulationDeactivated
    W4_SELECT --> IDLE: onHostCardEmulationDeactivated
    W4_SERVICE --> IDLE: 服务绑定超时
    IDLE --> POLLING_LOOP: 检测到轮询帧
    POLLING_LOOP --> W4_SELECT: 已激活
    POLLING_LOOP --> IDLE: 已停用
```

当收到 SELECT APDU 时：

1. 从 APDU 中提取 AID（`CLA=0x00, INS=0xA4, P1=0x04, P2=0x00`）
2. 在 `RegisteredAidCache` 中查找该 AID
3. 若解析出的服务与当前绑定的服务不同，则解绑旧服务并绑定新服务
4. 通过 `Messenger` 把 APDU 转发给服务
5. 把服务的响应经 NCI 协议栈回传

### 38.6.8 RegisteredAidCache：AID 解析

`RegisteredAidCache` 维护一个从 AID 到服务的 `TreeMap`。它只定义路由限定符：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/cardemulation/
//         RegisteredAidCache.java
static final int AID_ROUTE_QUAL_SUBSET = 0x20;
static final int AID_ROUTE_QUAL_PREFIX = 0x10;
```

四个 AID 匹配支持级别本身是 `AidRoutingManager.java` 中的 `AID_MATCHING_*` 常量，通过 `RoutingOptionManager.getAidMatchingSupport()` 查询：

| 模式 | 常量 | 行为 |
|------|----------|----------|
| 仅精确 | `AID_MATCHING_EXACT_ONLY` | AID 必须精确匹配 |
| 精确或前缀 | `AID_MATCHING_EXACT_OR_PREFIX` | AID 匹配或前缀匹配 |
| 仅前缀 | `AID_MATCHING_PREFIX_ONLY` | 所有 AID 均按前缀匹配 |
| 精确、子集或前缀 | `AID_MATCHING_EXACT_OR_SUBSET_OR_PREFIX` | 最灵活 |

电源状态路由控制某条路由在何时生效：

```java
static final int POWER_STATE_SWITCH_ON = 0x1;
static final int POWER_STATE_SWITCH_OFF = 0x2;
static final int POWER_STATE_BATTERY_OFF = 0x4;
static final int POWER_STATE_SCREEN_OFF_UNLOCKED = 0x8;
static final int POWER_STATE_SCREEN_ON_LOCKED = 0x10;
static final int POWER_STATE_SCREEN_OFF_LOCKED = 0x20;
```

### 38.6.9 AidRoutingManager：NFCC 路由表

`AidRoutingManager` 把解析得到的 AID 映射转换为实际的 NFCC 路由表：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/cardemulation/
//         AidRoutingManager.java
public class AidRoutingManager {
    static final int ROUTE_HOST = 0x00;

    int mDefaultRoute;
    int mDefaultIsoDepRoute;
    int mDefaultOffHostRoute;
    int mDefaultFelicaRoute;
    int mDefaultSysCodeRoute;

    // Routing table: route ID -> set of AIDs
    SparseArray<Set<String>> mAidRoutingTable;
    // Reverse lookup: AID -> route ID
    HashMap<String, Integer> mRouteForAid;
    // Power state per AID
    HashMap<String, Integer> mPowerForAid;
    ...
}
```

路由表的大小受 NFCC 硬件限制（`mMaxAidRoutingTableSize`）。当表项超过该上限时，管理器必须对条目做优先级排序或压缩。

### 38.6.10 首选支付服务与钱包角色

Android 指定一个“首选支付服务”，默认处理支付类 AID。该指定与**钱包角色**（`RoleManager.ROLE_WALLET`）绑定，后者取代了较早的“默认支付应用”设置：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/cardemulation/
//         CardEmulationManager.java
final WalletRoleObserver mWalletRoleObserver;
final PreferredServices mPreferredServices;
```

`WalletRoleObserver` 通过 `RoleManager` 监视角色变化，并按用户解析当前持有者：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/cardemulation/
//         WalletRoleObserver.java
public PackageAndUser getDefaultWalletRoleHolder(int userId) {
    // ...
    List<String> roleHolders = mRoleManager.getRoleHoldersAsUser(
            RoleManager.ROLE_WALLET, roleUserHandle);
    // ...
}
```

当持有者变化时，`CardEmulationManager.onWalletRoleHolderChanged()` 会把新的包分发给 `PreferredServices` 与 `RegisteredAidCache`（`packages/modules/Nfc/NfcNci/src/com/android/nfc/cardemulation/CardEmulationManager.java`），从而使路由表跟随钱包角色。

钱包角色持有者在以下方面获得优先权：

- 支付类别的 AID
- 触碰支付（tap-to-pay）UI
- 默认非接触支付选择

Android 17 扩展了钱包角色的覆盖范围。38.10 节介绍新增的**关联包**（associated package）机制。借助该机制，角色持有者可以把角色持有者级别的路由优先权授予一个同级包，而该包本身无需拥有该角色。

### 38.6.11 观察模式与轮询环过滤

观察模式（observe mode）是一项高级特性，允许 HCE 服务在不完全激活卡模拟事务的情况下接收轮询环帧。这使以下能力成为可能：

- 在暴露卡凭据之前先检测读取器是否存在
- 实现自定义的事务流程
- 支持隐私保护型支付协议

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcService.java
@Override
public void onPollingLoopDetected(List<PollingFrame> frames) {
    if (mCardEmulationManager != null) {
        synchronized (mPollingLoopsDetectedRunnable) {
            mPollingFramesToBeSent.addAll(frames);
            if (!mHandler.hasCallbacks(mPollingLoopsDetectedRunnable)) {
                mHandler.post(mPollingLoopsDetectedRunnable);
            }
        }
    }
}
```

该回调不会在调用线程里直接转发帧。它把帧批量收集到 `mPollingFramesToBeSent`，并向 `mHandler` 投递 `mPollingLoopsDetectedRunnable`。随后处理器线程会排空该列表，并在处理器线程上调用 `mCardEmulationManager.onPollingLoopDetected()`。

固件可以自主启用或停用观察模式：

```java
@Override
public void onObserveModeDisabledInFirmware(PollingFrame exitFrame) {
    mCardEmulationManager.onObserveModeDisabledInFirmware(exitFrame);
    onObserveModeStateChanged(false);
}

@Override
public void onObserveModeEnabledInFirmware() {
    onObserveModeStateChanged(true);
}
```

应用通过 `NfcAdapter.setObserveModeEnabled(boolean)` 切换观察模式，可用性由 `isObserveModeSupported()` 判定。若已有事务或标签操作正在进行，服务会拒绝该切换，因此状态机绝不会在 APDU 处理中途翻转：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcService.java
private boolean setObserveModeInternal(boolean enable, int callingUid,
        String packageName, int triggerSource) {
    synchronized (NfcService.this) {
        if (mCardEmulationManager.isHostCardEmulationActivated()) {
            return false;   // cannot toggle during a transaction
        }
        if (mTagConnected) {
            return false;   // cannot toggle during tag operations
        }
        boolean result = mDeviceHost.setObserveMode(enable);
        // ... statsd + event log ...
    }
}
```

Android 17 新增了 `NfcAdapter.allowOneTransaction()`（由 `packages/modules/Nfc/flags/flags.aconfig` 中的 `nfcstack_26q2_updates` 标志控制）。它会针对*单次* HCE 事务临时停用观察模式，并在事务完成或射频场消失后自动重新启用观察模式。这正是钱包用来放行一次触碰支付、又不必永久关闭观察模式的构件。该能力经由 `INfcAdapter.allowOneTransaction()`（`packages/modules/Nfc/framework/java/android/nfc/INfcAdapter.aidl`）到达服务。

### 38.6.12 离主机卡模拟

离主机卡模拟把 APDU 直接路由到安全元件（eSE 或 UICC），不经过应用处理器。它用于：

- 基于 SIM 的支付
- 电信应用
- 高安全等级凭据

路由通过 `NfcConfig` 配置：

```
// From NfcConfig:
byte defaultOffHostRoute;       // Default off-host destination
byte[] offHostRouteUicc;        // UICC route IDs
byte[] offHostRouteEse;         // eSE route IDs
```

应用通过 `OffHostApduService` 声明离主机服务：

```xml
<service android:name=".MyOffHostService"
         android:exported="true"
         android:permission="android.permission.BIND_NFC_SERVICE">
    <intent-filter>
        <action android:name=
            "android.nfc.cardemulation.action.OFF_HOST_APDU_SERVICE" />
    </intent-filter>
    <meta-data android:name=
            "android.nfc.cardemulation.off_host_apdu_service"
               android:resource="@xml/offhost_service" />
</service>
```

### 38.6.13 HCE 安全考量

1. **没有硬件隔离** —— 与基于 SE 的模拟不同，HCE 在应用处理器上处理 APDU。被攻破的操作系统可以截获事务数据。

2. **令牌化** —— 支付网络通过使用令牌化的 PAN 来缓解风险，这类 PAN 即使被截获也无法使用。

3. **设备解锁要求** —— 服务可以要求设备处于解锁状态（`android:requireDeviceUnlock="true"`）。

4. **BIND_NFC_SERVICE 权限** —— 只有 NFC 系统服务才能绑定到 HCE 服务，从而阻止恶意应用截获 APDU。

5. **AID 冲突解决** —— 当多个应用注册同一 AID 时，系统对“other”类别弹出选择器；对“payment”类别则使用默认支付服务。

---

## 38.7 安全元件

### 38.7.1 什么是安全元件

安全元件（Secure Element，SE）是一种可运行 Java Card applet 的防篡改硬件组件。它为敏感操作（例如支付凭据存储）提供硬件隔离的执行环境。

Android 设备中存在三类 SE：

```mermaid
graph TD
    NFC["NFC 控制器"]
    NFC -->|"SWP\n（单线协议）"| UICC["UICC SE\n（在 SIM 卡中）"]
    NFC -->|"SPI/I2C"| ESE["嵌入式 SE\n（焊接在板上）"]
    NFC -->|"内部"| DHSE["设备主机 SE\n（软件 SE，少见）"]

    AP["应用处理器"]
    AP -->|"OMAPI"| UICC
    AP -->|"OMAPI"| ESE
```

### 38.7.2 eSE：嵌入式安全元件

eSE 是一颗焊接在设备主板上的专用芯片。它永久连接到 NFC 控制器，并且可选地对应用处理器开放。主要特征：

- 用户不可拆卸
- 由设备制造商控制
- 即使设备断电也能执行非接触事务（电池离线模式）
- 通过 SPI、I2C 或专有接口连接到 NFCC

在 `NfcConfig` 中，eSE 由以下字段标识：

```
byte[] offHostRouteEse;     // Route IDs for eSE
byte offHostESEPipeId;      // HCI pipe ID for eSE
```

### 38.7.3 基于 UICC 的安全元件

UICC（Universal Integrated Circuit Card，通用集成电路卡，即 SIM 卡）内含一个集成 SE。它通过单线协议（SWP）连接到 NFC 控制器：

- 可拆卸，由移动网络运营商控制
- 包含电信 applet（SIM 工具箱）
- 可承载由运营商配置的支付 applet
- 移除 SIM 卡时连接中断

在 `NfcConfig` 中：

```
byte[] offHostRouteUicc;    // Route IDs for UICC
byte offHostSIMPipeId;      // HCI pipe ID for SIM
byte[] offHostSimPipeIds;   // Multiple SIM pipe IDs
```

### 38.7.4 OMAPI：开放移动 API

OMAPI（Open Mobile API）允许应用通过 `android.se.omapi` 包直接与安全元件通信。NfcService 通过如下方式与 OMAPI 集成：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcService.java
private ISecureElementService mSEService;
```

OMAPI 提供：

- `SEService` —— SE 访问的入口
- `Reader` —— 表示某个具体 SE（eSE 或某个 UICC 槽位）
- `Session` —— 与 SE 的一次通信会话
- `Channel` —— 用于 APDU 交换的逻辑通道

访问 OMAPI 需要 `android.permission.SECURE_ELEMENT_PRIVILEGED_OPERATION` 权限才能执行特权操作，否则需依据存储在 SE 自身的按 AID 访问控制规则。

### 38.7.5 NFC 控制器中的 SE 路由

NFCC 维护若干路由条目，把非接触事务导向恰当的安全元件：

```mermaid
graph TD
    READER["外部读取器"]
    READER -->|"射频（ISO-DEP）"| NFCC["NFC 控制器"]

    NFCC -->|"AID A0000000041010"| HOST["主机\n（HCE 支付应用）"]
    NFCC -->|"AID A0000000031010"| ESE["eSE\n（Mastercard applet）"]
    NFCC -->|"AID A000000003101001"| UICC["UICC\n（SIM 支付）"]
    NFCC -->|"默认 ISO-DEP"| HOST
    NFCC -->|"NFC-F"| ESE
```

路由维度：

| 路由类型 | 解析方式 | NCI 配置 |
|-------------|-----------|------------|
| 基于 AID | 特定 AID 到特定目的地 | RF_SET_LISTEN_MODE_ROUTING |
| 基于协议 | ISO-DEP/NFC-DEP 到默认目的地 | 技术路由 |
| 基于技术 | NFC-A/B/F 到默认目的地 | 技术路由 |

### 38.7.6 来自 SE 的事务事件

当离主机 SE 处理一笔事务时，NfcService 会收到通知，并广播给感兴趣的应用：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcService.java
@Override
public void onNfcTransactionEvent(byte[] aid, byte[] data, String seName) {
    byte[][] dataObj = {aid, data, seName.getBytes()};
    sendMessage(MSG_TRANSACTION_EVENT, dataObj);
}
```

`MSG_TRANSACTION_EVENT` 处理器会广播 `ACTION_TRANSACTION_DETECTED`：

```java
// NfcAdapter constant:
public static final String ACTION_TRANSACTION_DETECTED =
        "android.nfc.action.TRANSACTION_DETECTED";
```

应用必须持有 `NFC_TRANSACTION_EVENT` 权限才能接收这些广播。

### 38.7.7 NfcConfig 中的 SE 参数

HAL 的 `NfcConfig` 含有多个与 SE 相关的参数：

| 参数 | 用途 |
|-----------|---------|
| `defaultOffHostRoute` | 离主机路由使用的默认 NFCEE ID |
| `defaultOffHostRouteFelica` | FeliCa 离主机路由使用的 NFCEE ID |
| `offHostESEPipeId` | 访问 eSE 使用的 HCI 管道 ID |
| `offHostSIMPipeId` | 访问 SIM 使用的 HCI 管道 ID |
| `offHostRouteUicc` | UICC NFCEE ID 数组 |
| `offHostRouteEse` | eSE NFCEE ID 数组 |
| `offHostSimPipeIds` | SIM 管道 ID 数组 |
| `hostAllowlist` | 哪些主机可访问 NFC |

### 38.7.8 离主机路由配置

`RoutingOptionManager` 集中管理离主机路由配置：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/cardemulation/
//         AidRoutingManager.java
int mDefaultOffHostRoute;  // from RoutingOptionManager
int mDefaultFelicaRoute;   // from RoutingOptionManager
int mDefaultSysCodeRoute;  // from RoutingOptionManager
byte[] mOffHostRouteUicc;  // from RoutingOptionManager
byte[] mOffHostRouteEse;   // from RoutingOptionManager
```

### 38.7.9 HCI 网络与管道

主机控制器接口（HCI）网络连接 NFC 控制器与安全元件。HCI 事件在 JNI 层处理：

```
// Source: packages/modules/Nfc/NfcNci/nci/jni/HciEventManager.cpp
```

HCI 网络在必要时会被复位：

```
// NfcEvent enum:
HCI_NETWORK_RESET = 4,
```

HCI 网络复位会清除所有管道连接，并要求重新初始化 SE 通信通道。

### 38.7.10 SE 访问控制

对安全元件的访问通过以下机制控制：

1. **访问规则应用主实例（ARA-M）** —— SE 上的一个 applet，存储把证书哈希映射到允许 AID 的访问控制规则
2. **访问控制执行器** —— OMAPI 内置的执行器，在允许通道操作前查询 ARA-M
3. **Android 权限** —— `SECURE_ELEMENT_PRIVILEGED_OPERATION` 用于特权访问
4. **SELinux** —— 对 SE 设备节点的进程级访问控制

---

## 38.8 读取器模式

### 38.8.1 读取器模式的作用

读取器模式为单个前台 Activity 提供对 NFC 标签操作的独占访问。激活时，它会：

- 停用卡模拟（手机不再作为卡响应）
- 停用点对点模式
- 把轮询聚焦于指定的 NFC 技术
- 把发现的标签直接投递到已注册的回调
- 绕过常规的标签分发系统

对于需要可靠、不被打断的标签通信的应用来说是必需的——例如交通卡读取器、标签写入器以及库存管理工具。

### 38.8.2 enableReaderMode API

主 API：

```java
// Source: packages/modules/Nfc/framework/java/android/nfc/NfcAdapter.java
public void enableReaderMode(Activity activity, ReaderCallback callback,
        int flags, Bundle extras) {
    mNfcActivityManager.enableReaderMode(activity, callback, flags, extras);
}
```

用法：

```java
@Override
protected void onResume() {
    super.onResume();
    NfcAdapter nfc = NfcAdapter.getDefaultAdapter(this);
    if (nfc != null) {
        nfc.enableReaderMode(this,
            new NfcAdapter.ReaderCallback() {
                @Override
                public void onTagDiscovered(Tag tag) {
                    // Handle the tag on a background thread
                    processTag(tag);
                }
            },
            NfcAdapter.FLAG_READER_NFC_A |
            NfcAdapter.FLAG_READER_NFC_B |
            NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK,
            null  // extras Bundle
        );
    }
}

@Override
protected void onPause() {
    super.onPause();
    NfcAdapter nfc = NfcAdapter.getDefaultAdapter(this);
    if (nfc != null) {
        nfc.disableReaderMode(this);
    }
}
```

### 38.8.3 前台分发系统

前台分发是一种较早的机制，它把标签路由优先交给前台 Activity，但不会停用卡模拟：

```java
@Override
protected void onResume() {
    super.onResume();
    NfcAdapter nfc = NfcAdapter.getDefaultAdapter(this);

    PendingIntent pendingIntent = PendingIntent.getActivity(this, 0,
            new Intent(this, getClass())
                    .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_MUTABLE);

    IntentFilter[] filters = new IntentFilter[] {
        new IntentFilter(NfcAdapter.ACTION_NDEF_DISCOVERED)
    };

    String[][] techLists = new String[][] {
        new String[] { NfcA.class.getName() }
    };

    nfc.enableForegroundDispatch(this, pendingIntent, filters, techLists);
}

@Override
protected void onNewIntent(Intent intent) {
    if (NfcAdapter.ACTION_NDEF_DISCOVERED.equals(intent.getAction())) {
        Tag tag = intent.getParcelableExtra(NfcAdapter.EXTRA_TAG);
        // Process the tag
    }
}

@Override
protected void onPause() {
    super.onPause();
    NfcAdapter.getDefaultAdapter(this).disableForegroundDispatch(this);
}
```

**对比：读取器模式与前台分发**

| 特性 | 读取器模式 | 前台分发 |
|---------|-------------|-------------------|
| 卡模拟 | 停用 | 激活 |
| 点对点模式 | 停用 | 激活 |
| 投递方式 | 回调 | Intent |
| NDEF 自动读取 | 可配置 | 始终尝试 |
| 线程 | 回调线程 | 主线程 |
| API 级别 | 19+ | 10+ |

### 38.8.4 读取器模式标志与技术掩码

读取器模式标志控制轮询哪些技术：

```java
// Source: packages/modules/Nfc/framework/java/android/nfc/NfcAdapter.java
public static final int FLAG_READER_NFC_A = 0x1;          // ISO 14443-3A
public static final int FLAG_READER_NFC_B = 0x2;          // ISO 14443-3B
public static final int FLAG_READER_NFC_F = 0x4;          // JIS X 6319-4
public static final int FLAG_READER_NFC_V = 0x8;          // ISO 15693
public static final int FLAG_READER_NFC_BARCODE = 0x10;   // Kovio barcode
public static final int FLAG_READER_SKIP_NDEF_CHECK = 0x80;     // Don't auto-read NDEF
public static final int FLAG_READER_NO_PLATFORM_SOUNDS = 0x100; // Suppress tap sound
```

它们映射为 NfcService 内部的轮询掩码：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcService.java
static final int NFC_POLL_A = 0x01;
static final int NFC_POLL_B = 0x02;
static final int NFC_POLL_F = 0x04;
static final int NFC_POLL_V = 0x08;
static final int NFC_POLL_B_PRIME = 0x10;
static final int NFC_POLL_KOVIO = 0x20;
```

### 38.8.5 存在性检查机制

存在性检查用于判定标签是否仍在范围内。共有三种算法可用：

```
// Source: hardware/interfaces/nfc/aidl/.../PresenceCheckAlgorithm.aidl
enum PresenceCheckAlgorithm {
    DEFAULT = 0,      // Stack decides
    I_BLOCK = 1,      // Send ISO-DEP I-Block
    ISO_DEP_NAK = 2,  // Send ISO-DEP NAK
}
```

NfcService 配置默认的存在性检查延迟：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcService.java
static final int DEFAULT_PRESENCE_CHECK_DELAY = 125;  // milliseconds
```

应用可以通过传给 `enableReaderMode()` 的 extras Bundle 自定义该延迟：

```java
Bundle extras = new Bundle();
extras.putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, 500);
nfc.enableReaderMode(this, callback, flags, extras);
```

### 38.8.6 NFC 发现参数

`NfcDiscoveryParameters` 封装 NFC 控制器的发现配置：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcDiscoveryParameters.java
NfcDiscoveryParameters mCurrentDiscoveryParameters =
        NfcDiscoveryParameters.getNfcOffParameters();
```

这些参数包括：

- 技术掩码（轮询哪些技术）
- 监听模式配置（卡模拟）
- 轮询间隔
- 依赖屏幕状态的行为

### 38.8.7 轮询技术掩码

默认的轮询技术掩码启用了大多数常见技术：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcService.java
static final int DEFAULT_POLL_TECH = 0x2f;
// Binary: 0010 1111
// Enabled: NFC_POLL_A | NFC_POLL_B | NFC_POLL_F | NFC_POLL_V | NFC_POLL_KOVIO

static final int DEFAULT_LISTEN_TECH = 0xf;
// Binary: 0000 1111
// Enabled: NFC_LISTEN_A | NFC_LISTEN_B | NFC_LISTEN_F | NFC_LISTEN_V
```

用户可以通过设置自定义轮询与监听技术掩码：

```java
static final String PREF_POLL_TECH = "polling_tech_dfl";
static final String PREF_LISTEN_TECH = "listen_tech_dfl";
```

### 38.8.8 标签去抖

标签去抖（debounce）可避免同一标签在很短时间内被多次分发：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcService.java
byte mDebounceTagUid[];
int mDebounceTagDebounceMs;
int mDebounceTagNativeHandle = INVALID_NATIVE_HANDLE;
ITagRemovedCallback mDebounceTagRemovedCallback;
```

当对某个标签调用 `ignore()` 时，其 UID 会存入 `mDebounceTagUid`。在指定的去抖时段内，任何具有相同 UID 的标签都会被静默忽略。

### 38.8.9 读取器模式与常规发现

```mermaid
graph LR
    subgraph "常规发现模式"
        N_POLL["轮询：A、B、F、V"]
        N_LISTEN["监听：A、B、F\n（卡模拟）"]
        N_BOTH["两者同时<br/>处于激活状态"]
    end

    subgraph "读取器模式"
        R_POLL["轮询：仅指定技术"]
        R_LISTEN["监听：已停用"]
        R_ONLY["仅有轮询生效"]
    end

    N_POLL --> N_BOTH
    N_LISTEN --> N_BOTH
    R_POLL --> R_ONLY
```

NFC 控制器行为的关键差异：

| 方面 | 常规模式 | 读取器模式 |
|--------|------------|-------------|
| 轮询 | 全部默认技术 | 仅指定标志对应的技术 |
| 监听 | 激活（HCE） | 停用 |
| NDEF 自动读取 | 始终 | 可配置 |
| 点对点 | 可用 | 停用 |
| 分发方式 | 基于 Intent | 基于回调 |
| 提示音 | 平台提示音 | 可配置 |

---

## 38.9 NFC-F（FeliCa）与 NFC-V

### 38.9.1 NFC-F：FeliCa 概述

NFC-F（JIS X 6319-4）是索尼 FeliCa 系统所用的非接触技术，在日本占据主导地位，用于：

- 交通卡（Suica、PASMO、ICOCA）
- 电子货币（Edy、nanaco、WAON）
- 身份识别卡

FeliCa 在标准 13.56 MHz 的 NFC 频率上使用一套专有通信方案，速率为 212 kbps 或 424 kbps。主要特征：

- **System Code（系统码）** —— 标识卡应用（类似 ISO-DEP 的 AID）
- **IDm（Manufacturer，制造商标识）** —— 生产时分配的 8 字节标识
- **PMm** —— 制造参数存储区

### 38.9.2 NfcF 标签技术类

`NfcF` 类提供对 NFC-F 标签属性及原始通信的访问：

```java
// Source: packages/modules/Nfc/framework/java/android/nfc/tech/NfcF.java
public final class NfcF extends BasicTagTechnology {
    public static final String EXTRA_SC = "systemcode";
    public static final String EXTRA_PMM = "pmm";

    private byte[] mSystemCode = null;
    private byte[] mManufacturer = null;

    public static NfcF get(Tag tag) {
        if (!tag.hasTech(TagTechnology.NFC_F)) return null;
        try { return new NfcF(tag); }
        catch (RemoteException e) { return null; }
    }

    // Get the system code (2 bytes)
    public byte[] getSystemCode() { return mSystemCode; }

    // Get the PMm (Manufacture Parameter) bytes captured at discovery;
    // the IDm/NFCID2 is the tag's getId(), not this getter
    public byte[] getManufacturer() { return mManufacturer; }

    // Send raw NFC-F commands and receive response
    public byte[] transceive(byte[] data) throws IOException { ... }

    // Maximum transceive length
    public int getMaxTransceiveLength() { ... }
}
```

用法：

```java
Tag tag = intent.getParcelableExtra(NfcAdapter.EXTRA_TAG);
NfcF nfcF = NfcF.get(tag);
if (nfcF != null) {
    nfcF.connect();
    byte[] systemCode = nfcF.getSystemCode();
    byte[] pmm = nfcF.getManufacturer();  // PMm (Manufacture Parameter)
    byte[] idm = tag.getId();             // IDm / NFCID2

    // FeliCa Read Without Encryption command (addressed by IDm)
    byte[] readCmd = buildFeliCaReadCommand(idm, serviceCode, blockList);
    byte[] response = nfcF.transceive(readCmd);

    nfcF.close();
}
```

### 38.9.3 基于主机的 NFC-F 模拟（HCE-F）

HCE-F 使 Android 能够模拟 FeliCa 卡，从而实现：

- 基于软件的交通卡模拟
- 使用 FeliCa 协议的移动支付
- 自定义的 FeliCa 服务

```mermaid
graph LR
    READER["FeliCa 读取器"]
    READER <-->|"NFC-F 协议"| NFCC["NFC 控制器"]
    NFCC <-->|"NCI"| HNFEM["HostNfcFEmulationManager"]
    HNFEM <-->|"Messenger"| SERVICE["HostNfcFService\n（你的应用）"]
```

### 38.9.4 HostNfcFService 与 HostNfcFEmulationManager

应用通过继承 `HostNfcFService` 实现 NFC-F 模拟：

```java
public class MyFeliCaService extends HostNfcFService {
    @Override
    public byte[] processNfcFPacket(byte[] packet, Bundle extras) {
        // Process incoming NFC-F command
        // Return response packet
        return buildResponse(packet);
    }

    @Override
    public void onDeactivated(int reason) {
        // Clean up
    }
}
```

`HostNfcFEmulationManager` 管理 NFC-F 模拟的生命周期：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/cardemulation/
//         HostNfcFEmulationManager.java
public class HostNfcFEmulationManager {
    static final int STATE_IDLE = 0;
    static final int STATE_W4_SERVICE = 1;
    static final int STATE_XFER = 2;

    static final int NFCID2_LENGTH = 8;
    static final int MINIMUM_NFCF_PACKET_LENGTH = 10;
    ...
}
```

### 38.9.5 T3T 标识符与系统码

NFC-F 卡模拟使用 T3T（Type 3 Tag）标识符而非 AID 来做路由：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcService.java
static final int MSG_REGISTER_T3T_IDENTIFIER = 12;
static final int MSG_DEREGISTER_T3T_IDENTIFIER = 13;
```

`RegisteredT3tIdentifiersCache` 维护系统码与 NFCID2 值到服务的映射：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/cardemulation/
//         CardEmulationManager.java
final RegisteredT3tIdentifiersCache mT3tIdentifiersCache;
```

系统码路由在 NFCC 中配置：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/cardemulation/
//         AidRoutingManager.java
int mDefaultSysCodeRoute;
```

### 38.9.6 NFC-V：ISO 15693（邻近卡）

NFC-V（ISO 15693）的作用距离比其他 NFC 技术更远（在某些配置下可达约 1 米）。它常用于：

- 图书馆图书标签
- 仓库库存标签
- 工业资产追踪
- 药品追踪

关键属性：

- **DSF ID**（Data Storage Format Identifier，数据存储格式标识符）——标识数据结构
- **Response Flags（响应标志）** ——来自标签的状态标志
- UID 为 8 字节（由制造商分配）

### 38.9.7 NfcV 标签技术类

```java
// Source: packages/modules/Nfc/framework/java/android/nfc/tech/NfcV.java
public final class NfcV extends BasicTagTechnology {
    public static final String EXTRA_RESP_FLAGS = "respflags";
    public static final String EXTRA_DSFID = "dsfid";

    private byte mRespFlags;
    private byte mDsfId;

    public static NfcV get(Tag tag) {
        if (!tag.hasTech(TagTechnology.NFC_V)) return null;
        try { return new NfcV(tag); }
        catch (RemoteException e) { return null; }
    }

    public byte getResponseFlags() { return mRespFlags; }
    public byte getDsfId() { return mDsfId; }

    // Send raw NFC-V commands (FLAGS, CMD, PARAMETER bytes)
    // CRC is automatically appended
    public byte[] transceive(byte[] data) throws IOException { ... }
}
```

用法：

```java
Tag tag = intent.getParcelableExtra(NfcAdapter.EXTRA_TAG);
NfcV nfcV = NfcV.get(tag);
if (nfcV != null) {
    nfcV.connect();

    byte dsfId = nfcV.getDsfId();
    byte respFlags = nfcV.getResponseFlags();

    // Read Single Block (ISO 15693 command 0x20)
    byte[] readCmd = new byte[] {
        0x02,  // FLAGS: high data rate
        0x20,  // READ_SINGLE_BLOCK command
        0x00   // Block number
    };
    byte[] response = nfcV.transceive(readCmd);

    nfcV.close();
}
```

### 38.9.8 其他标签技术：NfcA、NfcB、IsoDep、MifareClassic、MifareUltralight

`android.nfc.tech` 中的完整标签技术类集合：

| 类 | 说明 | 关键方法 |
|-------|-------------|-------------|
| `NfcA` | ISO 14443-3A | `getAtqa()`、`getSak()`、`transceive()` |
| `NfcB` | ISO 14443-3B | `getApplicationData()`、`getProtocolInfo()`、`transceive()` |
| `IsoDep` | ISO 14443-4 | `getHistoricalBytes()`、`getHiLayerResponse()`、`transceive()` |
| `Ndef` | 已按 NDEF 格式化 | `getNdefMessage()`、`writeNdefMessage()`、`makeReadOnly()` |
| `NdefFormatable` | 可被格式化 | `format()`、`formatReadOnly()` |
| `MifareClassic` | NXP MIFARE Classic | `authenticateSectorWithKeyA()`、`authenticateSectorWithKeyB()`、`readBlock()`、`writeBlock()` |
| `MifareUltralight` | NXP MIFARE Ultralight | `readPages()`、`writePage()` |
| `NfcBarcode` | Kovio 条码 | `getType()`、`getBarcode()` |

所有技术类都继承 `BasicTagTechnology`，后者提供：

- `connect()` —— 建立通信
- `close()` —— 释放通信
- `isConnected()` —— 检查连接状态
- `getTag()` —— 获取底层 Tag 对象

```mermaid
classDiagram
    class TagTechnology {
        <<interface>>
        +getTag() Tag
        +connect()
        +close()
        +isConnected() boolean
    }

    class BasicTagTechnology {
        #Tag mTag
        #int mSelectedTechnology
        +transceive(byte[]) byte[]
    }

    class NfcA {
        +getAtqa() byte[]
        +getSak() short
        +transceive() byte[]
    }

    class NfcB {
        +getApplicationData() byte[]
        +getProtocolInfo() byte[]
    }

    class NfcF {
        +getSystemCode() byte[]
        +getManufacturer() byte[]
    }

    class NfcV {
        +getResponseFlags() byte
        +getDsfId() byte
    }

    class IsoDep {
        +getHistoricalBytes() byte[]
        +getHiLayerResponse() byte[]
        +setTimeout(int)
    }

    class Ndef {
        +getNdefMessage() NdefMessage
        +writeNdefMessage(NdefMessage)
        +makeReadOnly() boolean
        +getType() String
        +getMaxSize() int
    }

    class MifareClassic {
        +authenticateSectorWithKeyA()
        +authenticateSectorWithKeyB()
        +readBlock(int) byte[]
        +writeBlock(int, byte[])
    }

    class MifareUltralight {
        +readPages(int) byte[]
        +writePage(int, byte[])
        +getType() int
    }

    TagTechnology <|-- BasicTagTechnology
    BasicTagTechnology <|-- NfcA
    BasicTagTechnology <|-- NfcB
    BasicTagTechnology <|-- NfcF
    BasicTagTechnology <|-- NfcV
    BasicTagTechnology <|-- IsoDep
    BasicTagTechnology <|-- Ndef
    BasicTagTechnology <|-- MifareClassic
    BasicTagTechnology <|-- MifareUltralight
```

---

## 38.10 Tap to X 与手势交换 API

Android 17 引入了一套新的系统 API 面，称为 **Tap to X**。它把一次非接触触碰变成应用可定义的“交换”手势，而不只是一次 NDEF 读取或一笔支付。其典型用例是 **Tap to Share**（触碰分享）：两台手机，或一台手机与一个配件，短暂地把 NFC 天线靠在一起。随后平台把一个可与之 transceive 的 `Tag` 交给前台应用。整个过程没有通常的 NDEF 分发、提示音或振动，且整套 API 面由 `tap_to_x` aconfig 标志控制。

#### 图示：Tap to X 手势交换流程

```mermaid
flowchart TD
    APP["特权应用<br/>（持有 PERFORM_GESTURE_EXCHANGE）"]
    LISTENER["NfcGestureExchangeCallbackListener<br/>(IReaderCallback.Stub)"]
    ADAPTER["NfcAdapter.registerGestureExchangeReaderCallback()"]
    SVC["NfcService.registerGestureExchangeCallback()"]
    POLL["轮询环<br/>onRemoteEndpointDiscovered()"]
    SELECT["SELECT GESTURE_EXCHAGE_AID<br/>(A00000047609)"]
    CB["callback.onTagDiscovered(gestureTag)"]

    APP --> ADAPTER
    ADAPTER --> LISTENER
    LISTENER -->|"registerGestureExchangeCallback（binder）"| SVC
    POLL -->|"ISO-DEP 端点"| SELECT
    SELECT -->|"90 00 成功"| CB
    CB --> LISTENER
    LISTENER -->|"executor.execute"| APP
```

### 38.10.1 PERFORM_GESTURE_EXCHANGE 权限

Tap to X 并非常规的应用能力。注册手势交换需要新增的签名级权限 `PERFORM_GESTURE_EXCHANGE`，并在服务内部强制执行：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcPermissions.java
static final String GESTURE_EXCHANGE_PERMISSION =
        android.Manifest.permission.PERFORM_GESTURE_EXCHANGE;

public static void enforceGestureExchangePermissions(Context context) {
    context.enforceCallingOrSelfPermission(GESTURE_EXCHANGE_PERMISSION,
            GESTURE_EXCHANGE_PERM_ERROR);
}
```

`NfcService` 中每个手势交换入口在触碰状态之前都会调用 `enforceGestureExchangePermissions()`。因此只有受信任的持有者（例如系统的 Tap-to-Share 组件）才能拦截该手势。

### 38.10.2 NfcGestureExchangeCallbackListener

应用并不直接与服务通信。`NfcAdapter` 持有一个唯一的 `NfcGestureExchangeCallbackListener`，它本身就是一个 `IReaderCallback.Stub` binder 对象，负责复用分发一个或多个应用的 `ReaderCallback`：

```java
// Source: packages/modules/Nfc/framework/java/android/nfc/
//         NfcGestureExchangeCallbackListener.java
public final class NfcGestureExchangeCallbackListener extends IReaderCallback.Stub {
    private final Map<ReaderCallback, Executor> mCallbackMap = new HashMap<>();

    public void register(@NonNull Executor executor, @NonNull ReaderCallback callback) {
        // first registration links to NFC service death and calls
        // NfcAdapter.getService().registerGestureExchangeCallback(this);
    }

    @Override
    public void onTagDiscovered(Tag tag) {
        // fan the tag out to each registered ReaderCallback on its executor
    }
}
```

面向应用的方法是 `NfcAdapter` 上的 `registerGestureExchangeReaderCallback()` 与 `unregisterGestureExchangeReaderCallback()`，二者都标注了 `@FlaggedApi(FLAG_TAP_TO_X)`，也都要求具备 `PERFORM_GESTURE_EXCHANGE` 权限（`packages/modules/Nfc/framework/java/android/nfc/NfcAdapter.java`）。该监听器还会安装一个 `DeathRecipient`。若 NFC 服务进程死亡，监听器会在服务恢复后重新注册回调。这样长期运行的 Tap-to-Share 组件就不会悄悄停止接收手势。

注册手势回调会隐式抑制平台反馈。文档指出其行为等同于传入 `FLAG_READER_NO_PLATFORM_SOUNDS`，因此手势触碰不会播放常见的标签提示音或振动。

### 38.10.3 手势交换 AID 与轮询环拦截

手势触碰的检测方式是选中一个固定的应用标识符，而非读取 NDEF。主 AID 是 `NfcService` 中的一个常量，通过 `NfcAdapter.getGestureExchangeAid()` 返回给调用方：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcService.java
public static final String GESTURE_EXCHAGE_AID = "A00000047609";
public static final String GESTURE_EXCHAGE_SECONDARY_AID_SETTINGS_KEY =
        "nfc.gesture_exchange_secondary_aid";
public static final String GESTURE_EXCHANGE_COMPONENT_SETTINGS_KEY =
        "nfc.gesture_exchange_component";
```

当配置了手势轮询帧时，`mGestureExchangeEnabled` 会被置位。随后发现处理器会在转入普通 NDEF 读取*之前*先检查该端点是否为手势 AID。对于一个没有读取器模式处于激活状态的 ISO-DEP 端点，`NfcService` 会对（可选的）次级 AID 发送一次 `SELECT`，然后再对主 `GESTURE_EXCHAGE_AID` 做同样的事。返回 `90 00` 状态字表示远端是一个手势目标：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcService.java
byte[] gestureAidCheckCmd = buildSelectAidCommand(GESTURE_EXCHAGE_AID);
respData = tag.transceive(gestureAidCheckCmd, false, retCode);
if (respData != null && respData.length >= 2
        && respData[respData.length - 2] == (byte) 0x90
        && respData[respData.length - 1] == 0x00) {
    // Gesture Exchange AID exists, skip NDEF read
    if (SdkLevel.isAtLeastC() && mNfcGestureExchangeCallback != null) {
        Tag gestureTag = buildGestureTag(tag, gestureComponent, GESTURE_EXCHAGE_AID);
        mNfcGestureExchangeCallback.onTagDiscovered(gestureTag);
    } else {
        // fall back to dispatching a synthetic gesture intent
    }
}
```

`buildGestureTag()` 把实时的 ISO-DEP 端点包装成一个 `Tag`。它还携带一条合成的 Android 应用记录（即配置的手势组件）以及一个 `EXTRA_AID`。这样即使在旧的 Intent 通路上，手势目标也会被精确分发到正确的组件。`mGestureExchangeEnabled` 标志本身由 `Settings.Secure` 中的一个轮询帧取值驱动，`NfcService` 中的 `ContentObserver` 监视该取值（`updateGesturePollFrame()`）。默认轮询帧还会通过 `mDeviceHost.setDefaultFrame()` 下发给控制器。

### 38.10.4 Tap-to-X 路由：手势、NDEF 与支付

手势通路是刻意*叠加*在既有分发链（38.5 节）之上，而非替换它。在 `onRemoteEndpointDiscovered()` 内部，对 ISO-DEP 端点的优先级为：

1. 前台应用显式的**读取器模式**请求直接胜出。
2. 否则，若**手势交换**已启用，服务会先选次级手势 AID，再选主手势 AID。一旦匹配就短路到手势回调（或一次合成的手势分发），并启动存在性检查。
3. 否则该端点转入普通 **NDEF 读取**与三层标签分发 Intent。

```mermaid
flowchart TD
    EP["发现 ISO-DEP 端点"]
    RM{"是否请求<br/>读取器模式？"}
    GE{"是否启用<br/>手势交换？"}
    SECOND{"次级 AID<br/>是否选中返回 90 00？"}
    PRIMARY{"主手势 AID<br/>是否选中返回 90 00？"}
    READER["投递给读取器模式回调"]
    GCB["把 gestureTag 投递给回调"]
    NDEF["NDEF 读取后进行标签分发"]
    EP --> RM
    RM -->|"是"| READER
    RM -->|"否"| GE
    GE -->|"否"| NDEF
    GE -->|"是"| SECOND
    SECOND -->|"是"| GCB
    SECOND -->|"否"| PRIMARY
    PRIMARY -->|"是"| GCB
    PRIMARY -->|"否"| NDEF
```

这样 Tap to X 对普通标签与普通支付触碰保持不可见。一张普通的 NDEF 海报或一张非接触卡绝不会应答手势 `SELECT`，因此会直接进入本章前面所述的 NDEF/HCE 通路。

## 38.11 钱包角色的关联包

Android 17 放宽了钱包角色（38.6.10 节）中固化的“单包”假设。此前只有唯一的 `ROLE_WALLET` 持有包能获得角色持有者级别的路由优先权。在 17 中，持有者可以**声明一个关联包**，与之共享该优先权。当钱包把其 NFC／观察模式逻辑放在同级应用、或放在以不同证书签名的应用里时，这一点尤为重要。

该机制通过清单中的应用属性 `PROPERTY_ALLOW_SHARED_ROLE_PRIORITY` 选择性开启：

```java
// Source: packages/modules/Nfc/framework/java/android/nfc/cardemulation/
//         CardEmulation.java
public static final String PROPERTY_ALLOW_SHARED_ROLE_PRIORITY =
        "android.nfc.cardemulation.PROPERTY_ALLOW_SHARED_ROLE_PRIORITY";
```

按其文档说明，角色持有者可以把该属性的 `android:value` 设为 `true`（与任何以同一证书签名的包共享优先权），也可以设为一个具体包名（只与那个包共享，即使签名不同）。`RegisteredAidCache` 会从钱包持有者读取该属性（若失败则退而读取首选支付服务），并记录该关联包，即使该包完全没有卡模拟服务：

```java
// Source: packages/modules/Nfc/NfcNci/src/com/android/nfc/cardemulation/
//         RegisteredAidCache.java
PackageManager.Property prop = pm.getProperty(
        CardEmulation.PROPERTY_ALLOW_SHARED_ROLE_PRIORITY,
        mDefaultWalletHolderPackageName);
// Associated wallet role package may not have any CE service (only for ability
// to toggle observe mode), so add these packages directly here.
if (prop.getString() != null) {
    mAssociatedRolePackageNames.add(prop.getString());
}
```

此后解析时，持有者与其关联包被同等对待。`isDefaultOrAssociatedWalletService()` 与 `isDefaultOrAssociatedWalletPackage()` 对持有者*或*任何关联服务/包都返回 `true`（受 `nfc_associated_role_services` 标志控制）。因此关联应用可以按角色持有者优先级注册 AID，并像钱包本身一样切换观察模式（38.6.11 节）。上面的源码注释给出了这一关联的常见动因：正是为了让一个辅助包能够代表钱包调用 `setObserveModeEnabled()` / `allowOneTransaction()`，而它本身并不拥有任何 HCE 服务。

## 38.12 Android 17 中的 NFC Mainline 标志

由于 NFC 以 `com.android.nfcservices` Mainline APEX 形式分发（38.1.8 节），几乎每一项 17 的行为变更都由一个 aconfig 标志控制。这样平台就能先合入代码，再按发布批次开启。大多数标志位于模块标志集 `packages/modules/Nfc/flags/flags.aconfig`（容器 `com.android.nfcservices`，访问器 `com.android.nfc.module.flags.Flags`）：

| 模块标志 | 控制的内容 |
|------|-------|
| `tap_to_x` | Tap to X／手势交换 API（38.10 节），以及 `ReaderCallback.onTagLost()` 与无 Activity 的读取器模式注册 |
| `nfcstack_26q2_updates` | NCI 协议栈更新，包括 `NfcAdapter.allowOneTransaction()`（38.6.11 节）与 V2 标签应用偏好存储 |
| `screen_state_attribute_toggle` | 在运行时切换 HCE 服务的 `requireDeviceUnlock` / `requireDeviceScreenOn` |
| `get_polling_loop_filters` | 获取某服务已注册的轮询环过滤器的 API |
| `nfc_power_saving_mode` | 获取/设置控制器的省电模式 |
| `oem_extension_25q4` | 面向 25Q4 批次的 OEM 扩展钩子（`NfcOemExtension`） |

另有少量框架侧标志位于 `android.nfc` 命名空间，控制 `framework/` 目录中的公开 API 面。此处最相关的是 `android.nfc.nfc_associated_role_services`，它控制钱包角色关联包特性（38.11 节）。它同时守护 `PROPERTY_ALLOW_SHARED_ROLE_PRIORITY` 字段（见 `packages/modules/Nfc/framework/api/current.txt`）以及 `packages/modules/Nfc/NfcNci/src/com/android/nfc/cardemulation/RegisteredAidCache.java` 中的 `Flags.nfcAssociatedRoleServices()` 分支。

模块标志通过生成的 `com.android.nfc.module.flags.Flags` 访问器读取（例如 `NfcAdapter` 方法上的 `@FlaggedApi(FLAG_TAP_TO_X)`）。要判断某项 Android 17 的 NFC 行为在设备上是否真的生效，最可靠的方式是在运行时读取相应标志。这是因为 Mainline 各批次独立于平台版本开启这些标志。

---

## 38.13 SecureElement 服务与 OMAPI 实现

38.7.4 节介绍了 OMAPI（开放移动 API）。借助 OMAPI，普通应用可以与运行在安全元件上的 applet 通信。本节深入讲解这一概念背后的实现：位于 `packages/apps/SecureElement/` 的 `SecureElement` 系统应用，它提供 `ISecureElementService` binder，支撑 `android.se.omapi` 的客户端类。它是一个独立应用，运行在自己的 `android.uid.se` 进程中，并不属于 NfcService。但正如 38.13.7 所示，它与 NfcService 共享同一批离主机 SE——NFC 卡模拟会把非接触事务路由到这些 SE。

### 38.13.1 谁实现 OMAPI

OMAPI 分为三层，分别位于源码树的不同位置：

| 层次 | 位置 | 职责 |
|-------|----------|------|
| 客户端 API | `frameworks/base/omapi/java/android/se/omapi/` | `SEService`、`Reader`、`Session`、`Channel` —— 应用调用的接口 |
| 服务 | `packages/apps/SecureElement/` | `SecureElementService` 与 `Terminal` —— binder 实现 |
| HAL | `hardware/interfaces/secure_element/aidl/` | `ISecureElement` —— 每个物理 SE 的厂商驱动 |

客户端 `SEService` 只是一个薄包装。当应用构造它时，会先向 `ServiceManager` 查询已注册的 binder，只有在查不到时才回退到绑定 `SecureElement` 应用导出的服务：

```java
// Source: frameworks/base/omapi/java/android/se/omapi/SEService.java
private static final String SERVICE_NAME = "android.se.omapi.ISecureElementService/default";
...
IBinder seService = ServiceManager.checkService(SERVICE_NAME);
// if found, use it directly; otherwise fall back to binding:
Intent intent = new Intent(ISecureElementService.class.getName());
mContext.bindService(intent, mConnection, Context.BIND_AUTO_CREATE);
...
mSecureElementService = ISecureElementService.Stub.asInterface(service);
```

绑定目标是 SecureElement 应用声明的 `<service>`，它按 `android.se.omapi.ISecureElementService` action 过滤：

```xml
<!-- Source: packages/apps/SecureElement/AndroidManifest.xml -->
<service android:name=".SecureElementService"
     android:visibleToInstantApps="true"
     android:exported="true">
    <intent-filter>
        <action android:name="android.se.omapi.ISecureElementService"/>
    </intent-filter>
</service>
```

因此客户端的 `Reader`、`Session` 与 `Channel` 只是服务回传的 `ISecureElementReader`、`ISecureElementSession` 与 `ISecureElementChannel` binder 的代理。

### 38.13.2 SecureElementService 与 Terminal

`SecureElementService` 是一个 `persistent`、`directBootAware` 的 `Service`。在 `onCreate()` 中，它通过为每个 HAL 实例尝试构造一个 `Terminal` 来枚举可用的 SE，随后以两个名称发布自身：

```java
// Source: packages/apps/SecureElement/src/com/android/se/SecureElementService.java
public static final String UICC_TERMINAL = "SIM";
public static final String ESE_TERMINAL = "eSE";
...
private void createTerminals() {
    // Check for all SE HAL implementations
    addTerminals(ESE_TERMINAL);
    addTerminals(UICC_TERMINAL);
}
```

`addTerminals()` 会循环构造 `eSE1`、`eSE2`…… 与 `SIM1`、`SIM2`……，直到 HAL 的 `getService()` 查找抛出 `NoSuchElementException`（该类型不再有实例）。每个存活的 `Terminal` 都会进入一个有序的 `LinkedHashMap<String, Terminal>`；该映射的键恰好就是客户端从 `SEService.getReaders()` 看到的读取器名称。UICC 终端还会被动态刷新：一个针对 `ACTION_MULTI_SIM_CONFIG_CHANGED` 的 `BroadcastReceiver` 会调用 `refreshUiccTerminals()`，在活动 SIM 数量变化时新增或关闭 `SIM<n>` 终端。

该服务以两个服务名注册，这与 AIDL VINTF 稳定性有关：

```java
// Source: packages/apps/SecureElement/src/com/android/se/SecureElementService.java
public static final String VSTABLE_SECURE_ELEMENT_SERVICE =
        "android.se.omapi.ISecureElementService/default";
...
if (getResources().getBoolean(R.bool.secure_element_vintf_enabled)) {
    ServiceManager.addService(VSTABLE_SECURE_ELEMENT_SERVICE,
            mSecureElementServiceBinderVntf);
}
...
mSecureElementServiceBinder.forceDowngradeToSystemStability();
ServiceManager.addService(Context.SECURE_ELEMENT_SERVICE, mSecureElementServiceBinder);
```

客户端 `SEService` 首先通过 `ServiceManager.checkService()` 查找的正是这个 VINTF 稳定名（`/default`），只有该查找失败时才回退到 `bindService()`——后者会把 `SecureElementService.onBind()` 返回的 binder 交给它。`Context.SECURE_ELEMENT_SERVICE`（`"secure_element"`）注册是一个独立的、系统稳定级别的发布，客户端从不查找它。

### 38.13.3 Terminal：每个安全元件一个对象

`Terminal` 通过 SE HAL 封装到某个物理 SE 的连接。它持有当前存在的 HAL 版本的引用，以及一个 `AccessControlEnforcer`：

```java
// Source: packages/apps/SecureElement/src/com/android/se/Terminal.java
private ISecureElement mSEHal;                                          // HIDL 1.0/1.1
private android.hardware.secure_element.V1_2.ISecureElement mSEHal12;   // HIDL 1.2
private android.hardware.secure_element.ISecureElement mAidlHal;        // AIDL

/** For each Terminal there will be one AccessController object. */
private AccessControlEnforcer mAccessControlEnforcer;
```

`Terminal` 驱动的 AIDL 接口很小，且以 APDU 为中心：

```java
// Source: hardware/interfaces/secure_element/aidl/android/hardware/secure_element/ISecureElement.aidl
byte[] getAtr();
boolean isCardPresent();
byte[] openBasicChannel(in byte[] aid, in byte p2);
LogicalChannelResponse openLogicalChannel(in byte[] aid, in byte p2);
void reset();
byte[] transmit(in byte[] data);
```

HAL 还会通过 `ISecureElementHalCallback` 的 `onStateChange(boolean)` 回调 `Terminal`。在连接建立时，终端会重新执行访问控制初始化；在断开连接时，它会复位执行器。

### 38.13.4 会话与通道

应用先在 `Reader` 上打开一个 `Session`，再在该会话上打开一个或多个通道。通道是与单个 applet 通信的单位，通过其 AID 选中：

- **基本通道**（通道 0）：每个 SE 恰好一个，且可能已选中某个默认 applet。当通道 0 已被占用时，`openBasicChannel()` 会拒绝第二次打开。
- **逻辑通道**（通道 1–19）：通过 `MANAGE CHANNEL` 打开，各自承载独立的 applet 选择。这是应用常用的路径。

`SecureElementSession`（`SecureElementService` 的内部类）实现了两个入口方法。二者都会校验会话处于打开状态、listener 非空、且 `p2` 属于允许的 `SELECT` 取值之一；随后解析调用方身份并委托给 `Terminal`：

```java
// Source: packages/apps/SecureElement/src/com/android/se/SecureElementService.java
channel = mReader.getTerminal().openLogicalChannel(this, aid, p2, listener,
        packageName, uuid, Binder.getCallingPid());
```

调用方身份来自 `getPackageNameFromCallingUid(Binder.getCallingUid())`。若该 UID 没有对应包（例如厂商的原生进程），代码会回退到厂商提供的 UUID 映射，但**仅限 eSE 终端**；在 UICC 上，基于 UUID 的访问会被拒绝。在 `Terminal.openLogicalChannel()` 内部，终端先计算 `ChannelAccess` 裁决（38.13.5 节），再针对检测到的 HAL 版本发起 HAL 调用：

```java
// Source: packages/apps/SecureElement/src/com/android/se/Terminal.java
channelAccess = setUpChannelAccess(aid, packageName, uuid, pid, false);
...
responseList.add(mAidlHal.openLogicalChannel(aid == null ? new byte[0] : aid, p2));
```

成功时会创建 `Channel` 对象，把计算出的 `ChannelAccess` 附加其上，并向客户端返回一个 `SecureElementChannel` binder。会话跟踪其所有已打开通道，并在 `closeChannels()` / `close()` 时强制关闭它们。

### 38.13.5 访问控制执行

这是 OMAPI 的安全关键部分。任意应用不能仅因为知道 AID 就能与支付或电信 applet 通信。SecureElement 服务实施一套 Global Platform 访问控制模型，在两处检查——一次在打开通道时，另一次在每个 APDU 上。

`Terminal.setUpChannelAccess()` 按以下顺序判定某次通道打开的裁决：

1. 若调用方持有 `android.permission.SECURE_ELEMENT_PRIVILEGED_OPERATION`，则获得 `ChannelAccess.getPrivilegeAccess()`——完全访问权限，无需查规则。
2. 在 UICC 终端上，若调用方具备**运营商特权**（由 SIM 认可的密钥签名），则获得运营商特权访问。该规则仅在 AID 不是 ISD-R 时适用。否则，普通应用在 UICC 上的 `openBasicChannel` 会被拒绝。
3. 其余情况下，向 `AccessControlEnforcer` 查询按 AID 的规则：

```java
// Source: packages/apps/SecureElement/src/com/android/se/Terminal.java
if (packageName != null && isPrivilegedApplication(packageName)) {
    return ChannelAccess.getPrivilegeAccess(packageName, pid);
}
...
ChannelAccess channelAccess =
        mAccessControlEnforcer.setUpChannelAccess(aid, packageName, uuid, checkRefreshTag);
```

`AccessControlEnforcer` 从 SE 自身获取规则，优先使用 ARA，回退到 ARF：

- **ARA（Access Rule Application，访问规则应用）** —— 一个专用 applet（即 ARA-M，AID 为 `A00000015141434C00`），存储 Global Platform 的 `REF-AR-DO` 规则。这些规则把调用方的证书哈希（以及可选的包名）映射到其可使用的 AID。`AraController` 向 ARA-M 打开一个逻辑通道，并用 `GET DATA` 读取规则。
- **ARF（Access Rule File，访问规则文件）** —— 位于（通常是 UICC）SE 上的 PKCS#15 文件结构，由 `ArfController` / `PKCS15Handler` 解析，在没有 ARA applet 时使用。

```java
// Source: packages/apps/SecureElement/src/com/android/se/security/AccessControlEnforcer.java
// 1 - Let's try to use ARA
if (mUseAra && mAraController != null) {
    ...
    mAraController.initialize();
    // disable other access methods
    mUseArf = false;
    mFullAccess = false;
}
// 2 - Let's try to use ARF since ARA cannot be used
if (mUseArf && mArfController != null) {
    mArfController.initialize();
    ...
}
/* 4 - Let's block everything since neither ARA, ARF or fullaccess can be used */
if (!mUseArf && !mUseAra && !mFullAccess) {
    mInitialChannelAccess.setApduAccess(ChannelAccess.ACCESS.DENIED);
    ...
}
```

默认姿态是故障关闭（fail-closed）。若 SE 既没有 ARA applet 也没有 ARF 文件，且未显式授予完全访问权限，则每一次通道打开都会被拒绝。匹配到的规则会缓存在 `AccessRuleCache` 中，并针对 SE 的 refresh tag 重新校验，使新配置的规则能够生效。

第二个强制点按 APDU 逐条执行。`Channel.transmit()` 会重新检查调用方 PID，阻止 `MANAGE CHANNEL` 以及（对非特权调用方）按 DF 名 `SELECT`，然后在 APDU 到达 HAL 之前回调执行器：

```java
// Source: packages/apps/SecureElement/src/com/android/se/Channel.java
checkCommand(command);
synchronized (mLock) {
    command[0] = setChannelToClassByte(command[0], mChannelNumber);
    return mTerminal.transmit(command);
}
```

`checkCommand()` 会咨询 `AccessControlEnforcer.checkCommand()`。它遵循规则附加到该通道的任何 APDU 过滤器（`APDU-AR-DO`）。因此一条规则可以允许某个 applet，同时限制允许使用的命令 APDU。

### 38.13.6 通道打开的端到端路径

下图追踪一个非特权应用向某个 applet 打开逻辑通道的过程，展示了在任何 APDU 到达 SE 之前访问控制是在何处被强制执行的。

```mermaid
sequenceDiagram
    participant App as "App (android.se.omapi.Session)"
    participant SES as "SecureElementService (android.uid.se)"
    participant Term as "Terminal (per SE)"
    participant ACE as "AccessControlEnforcer"
    participant HAL as "SE HAL (ISecureElement)"
    participant SE as "Secure Element / Applet"

    App->>SES: "openLogicalChannel(aid, p2)"
    SES->>SES: "resolve package from calling UID"
    SES->>Term: "openLogicalChannel(session, aid, p2, pkg, pid)"
    Term->>ACE: "setUpChannelAccess(aid, pkg)"
    ACE->>HAL: "open channel to ARA-M, GET DATA (rules)"
    HAL->>SE: "read ARA / ARF access rules"
    SE-->>ACE: "REF-AR-DO rules"
    ACE-->>Term: "ChannelAccess (ALLOWED or DENIED)"
    alt access allowed
        Term->>HAL: "openLogicalChannel(aid, p2)"
        HAL->>SE: "MANAGE CHANNEL + SELECT aid"
        SE-->>HAL: "channel number + SELECT response"
        HAL-->>Term: "LogicalChannelResponse"
        Term-->>SES: "Channel (access attached)"
        SES-->>App: "ISecureElementChannel"
    else access denied
        Term-->>SES: "SecurityException / null"
        SES-->>App: "open fails"
    end
```

### 38.13.7 OMAPI 与 NFC 卡模拟的关系

OMAPI（应用处理器经 SPI/I2C/SWP 访问 applet）与 NFC 离主机卡模拟（38.6、38.7 节）都会到达同一个物理 eSE / UICC，但走不同路径。OMAPI 的路径是应用 → `SecureElementService` → SE HAL；非接触事务的路径是外部读取器 → NFCC → 经射频/HCI 链路到 SE，应用处理器不在链路中。

二者在 `NFC_AR_DO` 访问规则处交汇。在 NfcService 广播离主机事务事件（38.7.6 节）之前，它会向 SecureElement 服务询问一个问题：某个包是否有权接收该 AID 的事件：

```java
// Source: packages/apps/SecureElement/src/com/android/se/SecureElementService.java
public synchronized boolean[] isNfcEventAllowed(String reader, byte[] aid,
        String[] packageNames, int userId) throws RemoteException {
    ...
    Terminal terminal = getTerminal(reader);
    ...
    return terminal.isNfcEventAllowed(context.getPackageManager(), aid, packageNames);
}
```

`Terminal.isNfcEventAllowed()` 通过执行器运行同一套 ARA/ARF 规则，但评估的是 `NFC-AR-DO`（NFC 事件访问）字段，而非 APDU 访问字段。因此，配置在 SE 上的访问规则同时治理两件事：谁可以通过 OMAPI 打开到某个 applet 的通道，以及当该 applet 处理非接触事务时谁可以收到通知。一套规则存储，两处强制面。

### 38.13.8 eUICC 与 ISD-R AID

同一个 SecureElement 服务还承担 eUICC（嵌入式 SIM）的 eSIM 配置文件管理前端。`Terminal` 通过一个固定 AID 识别 ISD-R（Issuer Security Domain Root，签发方安全域根）applet，并在访问控制中对其做特殊处理：

```java
// Source: packages/apps/SecureElement/src/com/android/se/Terminal.java
public static final byte[] ISD_R_AID =
        new byte[]{ (byte) 0xA0, 0x00, 0x00, 0x05, 0x59, 0x10, 0x10, ... };
...
// Check carrier privilege when AID is not ISD-R
if (packageName != null && getName().startsWith(SecureElementService.UICC_TERMINAL)
        && !Arrays.equals(aid, ISD_R_AID)) {
    ... checkCarrierPrivilege ...
}
```

LPA（Local Profile Assistant，本地配置文件助手）组件负责下载并安装 eSIM 配置文件，它使用到 ISD-R 的 OMAPI 逻辑通道。之所以对 ISD-R 跳过运营商特权检查，恰恰是因为 eSIM 管理改由特权权限来把关。

---

## 38.14 动手实践：NFC 开发练习

### 38.14.1 练习 1：读取 NDEF 标签

**目标**：构建一个从标签读取 NDEF 消息的 Activity。

```java
public class ReadNdefActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_read_ndef);
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        String action = intent.getAction();
        if (NfcAdapter.ACTION_NDEF_DISCOVERED.equals(action)
                || NfcAdapter.ACTION_TECH_DISCOVERED.equals(action)
                || NfcAdapter.ACTION_TAG_DISCOVERED.equals(action)) {

            Parcelable[] rawMessages = intent.getParcelableArrayExtra(
                    NfcAdapter.EXTRA_NDEF_MESSAGES);

            if (rawMessages != null) {
                NdefMessage[] messages = new NdefMessage[rawMessages.length];
                for (int i = 0; i < rawMessages.length; i++) {
                    messages[i] = (NdefMessage) rawMessages[i];
                }
                processNdefMessages(messages);
            }

            Tag tag = intent.getParcelableExtra(NfcAdapter.EXTRA_TAG);
            byte[] tagId = intent.getByteArrayExtra(NfcAdapter.EXTRA_ID);
            Log.d("NFC", "Tag ID: " + bytesToHex(tagId));
            Log.d("NFC", "Tag techs: " +
                    Arrays.toString(tag.getTechList()));
        }
    }

    private void processNdefMessages(NdefMessage[] messages) {
        for (NdefMessage msg : messages) {
            for (NdefRecord record : msg.getRecords()) {
                short tnf = record.getTnf();
                byte[] type = record.getType();
                byte[] payload = record.getPayload();

                Log.d("NFC", "TNF: " + tnf);
                Log.d("NFC", "Type: " + new String(type));

                Uri uri = record.toUri();
                if (uri != null) {
                    Log.d("NFC", "URI: " + uri.toString());
                }

                String mime = record.toMimeType();
                if (mime != null) {
                    Log.d("NFC", "MIME: " + mime);
                    Log.d("NFC", "Data: " + new String(payload));
                }
            }
        }
    }

    private static String bytesToHex(byte[] bytes) {
        if (bytes == null) return "null";
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) {
            sb.append(String.format("%02X", b));
        }
        return sb.toString();
    }
}
```

**清单注册**：

```xml
<activity android:name=".ReadNdefActivity"
          android:exported="true"
          android:launchMode="singleTop">
    <intent-filter>
        <action android:name="android.nfc.action.NDEF_DISCOVERED" />
        <category android:name="android.intent.category.DEFAULT" />
        <data android:mimeType="text/plain" />
    </intent-filter>
    <intent-filter>
        <action android:name="android.nfc.action.NDEF_DISCOVERED" />
        <category android:name="android.intent.category.DEFAULT" />
        <data android:scheme="https" />
    </intent-filter>
</activity>
```

**验证**：用 NFC TagWriter 之类的工具写入一个 NDEF URI 标签，然后让手机贴近。该 Activity 应被启动并显示标签内容。

### 38.14.2 练习 2：写入 NDEF 标签

**目标**：把 NDEF 内容写入空白或可重写标签。

```java
public class WriteNdefActivity extends Activity {
    private NfcAdapter mNfcAdapter;
    private PendingIntent mPendingIntent;
    private boolean mWriteMode = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_write_ndef);

        mNfcAdapter = NfcAdapter.getDefaultAdapter(this);
        mPendingIntent = PendingIntent.getActivity(this, 0,
                new Intent(this, getClass())
                        .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_MUTABLE);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Enable foreground dispatch to catch any tag
        mNfcAdapter.enableForegroundDispatch(this, mPendingIntent,
                null, null);
    }

    @Override
    protected void onPause() {
        super.onPause();
        mNfcAdapter.disableForegroundDispatch(this);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (mWriteMode) {
            Tag tag = intent.getParcelableExtra(NfcAdapter.EXTRA_TAG);
            writeTag(tag);
        }
    }

    private void writeTag(Tag tag) {
        // Build the NDEF message
        NdefRecord uriRecord = NdefRecord.createUri("https://android.com");
        NdefRecord textRecord = NdefRecord.createTextRecord("en",
                "Hello from AOSP Internals!");
        NdefRecord aarRecord = NdefRecord.createApplicationRecord(
                "com.example.nfcdemo");

        NdefMessage message = new NdefMessage(uriRecord, textRecord,
                aarRecord);

        try {
            Ndef ndef = Ndef.get(tag);
            if (ndef != null) {
                ndef.connect();
                if (!ndef.isWritable()) {
                    Log.e("NFC", "Tag is read-only");
                    return;
                }
                if (ndef.getMaxSize() < message.toByteArray().length) {
                    Log.e("NFC", "Tag capacity too small");
                    return;
                }
                ndef.writeNdefMessage(message);
                Log.d("NFC", "Write successful!");
                ndef.close();
            } else {
                // Try to format the tag
                NdefFormatable formatable = NdefFormatable.get(tag);
                if (formatable != null) {
                    formatable.connect();
                    formatable.format(message);
                    formatable.close();
                    Log.d("NFC", "Format and write successful!");
                } else {
                    Log.e("NFC", "Tag does not support NDEF");
                }
            }
        } catch (Exception e) {
            Log.e("NFC", "Write failed", e);
        }
    }

    public void enableWriteMode() {
        mWriteMode = true;
        // Show UI indicating "tap a tag to write"
    }
}
```

**验证**：贴近一张空白 NTAG213/215/216 标签，然后用练习 1 或任一 NFC 读取应用把它读回来。

### 38.14.3 练习 3：实现一个支付类 HCE 服务

**目标**：构建一个能响应支付 SELECT 命令的最小 HCE 服务。

**服务实现**：

```java
public class DemoPaymentService extends HostApduService {
    private static final String TAG = "DemoPaymentService";

    // Visa AID
    private static final String VISA_AID = "A0000000041010";

    // Status words
    private static final byte[] SW_OK = {(byte) 0x90, 0x00};
    private static final byte[] SW_UNKNOWN = {0x6F, 0x00};
    private static final byte[] SW_CLA_NOT_SUPPORTED = {0x6E, 0x00};
    private static final byte[] SW_INS_NOT_SUPPORTED = {0x6D, 0x00};

    // SELECT response: FCI template
    private static final byte[] SELECT_RESPONSE = buildSelectResponse();

    @Override
    public byte[] processCommandApdu(byte[] apdu, Bundle extras) {
        Log.d(TAG, "Received APDU: " + bytesToHex(apdu));

        if (apdu.length < 4) {
            return SW_UNKNOWN;
        }

        byte cla = apdu[0];
        byte ins = apdu[1];

        // Handle SELECT command (INS = 0xA4)
        if (ins == (byte) 0xA4) {
            return handleSelect(apdu);
        }

        // Handle GET PROCESSING OPTIONS (INS = 0xA8)
        if (ins == (byte) 0xA8) {
            return handleGpo(apdu);
        }

        return SW_INS_NOT_SUPPORTED;
    }

    @Override
    public void onDeactivated(int reason) {
        Log.d(TAG, "Deactivated: " +
                (reason == DEACTIVATION_LINK_LOSS ?
                        "link loss" : "deselected"));
    }

    private byte[] handleSelect(byte[] apdu) {
        // Extract AID from SELECT APDU
        if (apdu.length >= 5) {
            int aidLength = apdu[4] & 0xFF;
            if (apdu.length >= 5 + aidLength) {
                byte[] aid = new byte[aidLength];
                System.arraycopy(apdu, 5, aid, 0, aidLength);
                Log.d(TAG, "SELECT AID: " + bytesToHex(aid));

                // Return FCI with SW 9000
                return concat(SELECT_RESPONSE, SW_OK);
            }
        }
        return SW_UNKNOWN;
    }

    private byte[] handleGpo(byte[] apdu) {
        // Return minimal GPO response
        // In production, this would contain real EMV data
        byte[] gpoResponse = {
            (byte) 0x80, 0x06,  // Response Format 1
            0x00, 0x00,         // AIP
            0x08, 0x01, 0x01, 0x00  // AFL
        };
        return concat(gpoResponse, SW_OK);
    }

    private static byte[] buildSelectResponse() {
        // Minimal FCI template
        return new byte[] {
            0x6F, 0x0B,                 // FCI Template
            (byte) 0x84, 0x07,          // DF Name (AID)
            (byte) 0xA0, 0x00, 0x00,    // Visa AID
            0x00, 0x04, 0x10, 0x10,
            (byte) 0xA5, 0x00           // FCI Proprietary Template (empty)
        };
    }

    // ... utility methods
}
```

**服务声明**（`res/xml/payment_service.xml`）：

```xml
<host-apdu-service xmlns:android="http://schemas.android.com/apk/res/android"
    android:description="@string/demo_payment_description"
    android:requireDeviceUnlock="false">

    <aid-group android:description="@string/payment_aids"
               android:category="payment">
        <aid-filter android:name="A0000000041010" />
    </aid-group>
</host-apdu-service>
```

**清单**：

```xml
<service android:name=".DemoPaymentService"
         android:exported="true"
         android:permission="android.permission.BIND_NFC_SERVICE">
    <intent-filter>
        <action android:name=
            "android.nfc.cardemulation.action.HOST_APDU_SERVICE" />
    </intent-filter>
    <meta-data android:name=
            "android.nfc.cardemulation.host_apdu_service"
               android:resource="@xml/payment_service" />
</service>
```

**验证**：在另一台手机上使用 NFC 读取应用，向 Visa AID 发送 SELECT APDU。

### 38.14.4 练习 4：使用读取器模式

**目标**：使用读取器模式实现不受卡模拟干扰的可靠标签读取。

```java
public class ReaderModeActivity extends Activity
        implements NfcAdapter.ReaderCallback {
    private NfcAdapter mNfcAdapter;
    private TextView mStatusText;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_reader_mode);
        mStatusText = findViewById(R.id.status_text);
        mNfcAdapter = NfcAdapter.getDefaultAdapter(this);
    }

    @Override
    protected void onResume() {
        super.onResume();
        Bundle options = new Bundle();
        options.putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, 250);

        mNfcAdapter.enableReaderMode(this, this,
                NfcAdapter.FLAG_READER_NFC_A |
                NfcAdapter.FLAG_READER_NFC_B |
                NfcAdapter.FLAG_READER_NFC_F |
                NfcAdapter.FLAG_READER_NFC_V,
                options);
    }

    @Override
    protected void onPause() {
        super.onPause();
        mNfcAdapter.disableReaderMode(this);
    }

    @Override
    public void onTagDiscovered(Tag tag) {
        // This runs on a binder thread -- not the main thread
        StringBuilder info = new StringBuilder();
        info.append("Tag UID: ").append(bytesToHex(tag.getId())).append("\n");
        info.append("Technologies:\n");
        for (String tech : tag.getTechList()) {
            info.append("  - ").append(tech).append("\n");
        }

        // Try to read NDEF
        Ndef ndef = Ndef.get(tag);
        if (ndef != null) {
            try {
                ndef.connect();
                NdefMessage msg = ndef.getNdefMessage();
                if (msg != null) {
                    info.append("NDEF message: ")
                        .append(msg.getRecords().length)
                        .append(" records\n");
                    for (NdefRecord record : msg.getRecords()) {
                        Uri uri = record.toUri();
                        if (uri != null) {
                            info.append("  URI: ").append(uri).append("\n");
                        }
                    }
                }
                ndef.close();
            } catch (Exception e) {
                info.append("Error: ").append(e.getMessage()).append("\n");
            }
        }

        // Try IsoDep for smart cards
        IsoDep isoDep = IsoDep.get(tag);
        if (isoDep != null) {
            try {
                isoDep.connect();
                isoDep.setTimeout(5000);

                // Send SELECT PPSE
                byte[] selectPpse = {
                    0x00, (byte) 0xA4, 0x04, 0x00,
                    0x0E,  // Lc = 14 bytes
                    0x32, 0x50, 0x41, 0x59, 0x2E, 0x53, 0x59, 0x53,
                    0x2E, 0x44, 0x44, 0x46, 0x30, 0x31,  // "2PAY.SYS.DDF01"
                    0x00   // Le
                };
                byte[] response = isoDep.transceive(selectPpse);
                info.append("PPSE response: ")
                    .append(bytesToHex(response)).append("\n");

                isoDep.close();
            } catch (Exception e) {
                info.append("IsoDep error: ")
                    .append(e.getMessage()).append("\n");
            }
        }

        final String result = info.toString();
        runOnUiThread(() -> mStatusText.setText(result));
    }
}
```

**验证**：贴近各种 NFC 标签与卡。该 Activity 应显示它们的技术细节与内容。

### 38.14.5 练习 5：前台分发

**目标**：使用前台分发拦截本应发往其他应用的标签。

```java
public class ForegroundDispatchActivity extends Activity {
    private NfcAdapter mNfcAdapter;
    private PendingIntent mPendingIntent;
    private IntentFilter[] mIntentFilters;
    private String[][] mTechLists;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_foreground);

        mNfcAdapter = NfcAdapter.getDefaultAdapter(this);

        mPendingIntent = PendingIntent.getActivity(this, 0,
                new Intent(this, getClass())
                        .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_MUTABLE);

        // Match all NDEF messages
        IntentFilter ndefFilter = new IntentFilter(
                NfcAdapter.ACTION_NDEF_DISCOVERED);
        try {
            ndefFilter.addDataType("*/*");
        } catch (IntentFilter.MalformedMimeTypeException e) {
            throw new RuntimeException(e);
        }

        // Match all tech tags
        IntentFilter techFilter = new IntentFilter(
                NfcAdapter.ACTION_TECH_DISCOVERED);

        mIntentFilters = new IntentFilter[] { ndefFilter, techFilter };

        // Match any NFC technology
        mTechLists = new String[][] {
            { NfcA.class.getName() },
            { NfcB.class.getName() },
            { NfcF.class.getName() },
            { NfcV.class.getName() },
            { IsoDep.class.getName() },
        };
    }

    @Override
    protected void onResume() {
        super.onResume();
        mNfcAdapter.enableForegroundDispatch(this,
                mPendingIntent, mIntentFilters, mTechLists);
    }

    @Override
    protected void onPause() {
        super.onPause();
        mNfcAdapter.disableForegroundDispatch(this);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Log.d("NFC", "Foreground dispatch received: " + intent.getAction());
        Tag tag = intent.getParcelableExtra(NfcAdapter.EXTRA_TAG);
        if (tag != null) {
            Log.d("NFC", "Tag: " + Arrays.toString(tag.getTechList()));
        }
    }
}
```

### 38.14.6 练习 6：导转 NFC 路由表

**目标**：用 `dumpsys` 检查 NFC 服务状态与路由表。

```bash
# Dump the full NFC service state
adb shell dumpsys nfc

# Key sections to examine:
# - "mState" -- NFC enabled/disabled
# - "Routing Table" -- AID routing entries
# - "HCE Services" -- registered HostApduService components
# - "Discovery Parameters" -- current polling configuration

# Example output analysis:
# Look for lines like:
#   mState=ON
#   mScreenState=ON_UNLOCKED
#   Routing table:
#       Default route: host
#       Routed to 0x0:
#           "A0000000041010"
#       Routed to 0x2:
#           "A0000000031010"
```

检查 NFC HAL：

```bash
# Check if NFC HAL is running
adb shell service list | grep nfc

# Check VINTF for NFC HAL declaration
adb shell cat /vendor/etc/vintf/manifest.xml | grep -A5 nfc

# Inspect NFC system properties
adb shell getprop | grep nfc
```

检查 NFC 控制器状态：

```bash
# Enable NFC debug logging
adb shell setprop persist.nfc.debug_enabled true

# View NFC logs
adb logcat -s NfcService:V NfcDispatcher:V NfcCardEmulationManager:V

# Enable NCI protocol snoop log
adb shell setprop persist.nfc.snoop_log_mode full
```

### 38.14.7 练习 7：通过 AIDL 检查 NFC HAL

**目标**：通过查阅 AIDL 定义理解 HAL 接口。

```bash
# Browse the AIDL HAL interface
find $ANDROID_BUILD_TOP/hardware/interfaces/nfc/aidl \
    -name "*.aidl" -not -path "*/aidl_api/*" | sort

# View the current frozen API
cat $ANDROID_BUILD_TOP/hardware/interfaces/nfc/aidl/\
    aidl_api/android.hardware.nfc/current/android/hardware/nfc/INfc.aidl

# Compare versions to see API evolution
diff $ANDROID_BUILD_TOP/hardware/interfaces/nfc/aidl/\
    aidl_api/android.hardware.nfc/1/android/hardware/nfc/INfc.aidl \
     $ANDROID_BUILD_TOP/hardware/interfaces/nfc/aidl/\
    aidl_api/android.hardware.nfc/2/android/hardware/nfc/INfc.aidl

# Run VTS tests against the HAL
atest VtsAidlHalNfcTargetTest
```

**可供探究的问题**：

1. AIDL v1 与 v2 之间新增了哪些方法？
2. `NfcConfig` 包含哪些字段？它们如何影响路由？
3. `INfcClientCallback` 会投递哪些事件？
4. HAL 如何处理电源管理（`NfcCloseType`）？

### 38.14.8 练习 8：NFC-F FeliCa 模拟

**目标**：构建一个最小的 NFC-F（FeliCa）卡模拟服务。

**服务实现**：

```java
public class DemoFeliCaService extends HostNfcFService {
    private static final String TAG = "DemoFeliCaService";

    // FeliCa command codes
    private static final byte CMD_POLLING = 0x04;
    private static final byte CMD_READ_WITHOUT_ENCRYPTION = 0x06;
    private static final byte RESP_READ_WITHOUT_ENCRYPTION = 0x07;

    @Override
    public byte[] processNfcFPacket(byte[] packet, Bundle extras) {
        Log.d(TAG, "Received NFC-F packet: " + bytesToHex(packet));

        if (packet.length < 10) {
            return null;  // Too short
        }

        byte length = packet[0];
        byte commandCode = packet[1];
        // NFCID2 is bytes 2-9

        switch (commandCode) {
            case CMD_READ_WITHOUT_ENCRYPTION:
                return handleReadWithoutEncryption(packet);
            default:
                Log.d(TAG, "Unknown command: " +
                        String.format("0x%02X", commandCode));
                return null;
        }
    }

    @Override
    public void onDeactivated(int reason) {
        Log.d(TAG, "FeliCa deactivated: reason=" + reason);
    }

    private byte[] handleReadWithoutEncryption(byte[] packet) {
        // Build a minimal Read Without Encryption response
        byte[] nfcid2 = new byte[8];
        System.arraycopy(packet, 2, nfcid2, 0, 8);

        // Response: Length + RespCode + NFCID2 + StatusFlag1 +
        //           StatusFlag2 + NumBlocks + BlockData
        byte[] blockData = "HelloFeliCa!1234".getBytes();  // 16 bytes
        byte[] response = new byte[1 + 1 + 8 + 1 + 1 + 1 + 16];
        response[0] = (byte) response.length;  // Length
        response[1] = RESP_READ_WITHOUT_ENCRYPTION;
        System.arraycopy(nfcid2, 0, response, 2, 8);
        response[10] = 0x00;  // Status Flag 1: success
        response[11] = 0x00;  // Status Flag 2: success
        response[12] = 0x01;  // Number of blocks
        System.arraycopy(blockData, 0, response, 13, 16);

        return response;
    }
}
```

**服务声明**（`res/xml/felica_service.xml`）：

```xml
<host-nfcf-service xmlns:android="http://schemas.android.com/apk/res/android"
    android:description="@string/demo_felica_description">
    <system-code-filter android:name="4000" />
    <nfcid2-filter android:name="02FE010203040506" />
</host-nfcf-service>
```

**清单**：

```xml
<service android:name=".DemoFeliCaService"
         android:exported="true"
         android:permission="android.permission.BIND_NFC_SERVICE">
    <intent-filter>
        <action android:name=
            "android.nfc.cardemulation.action.HOST_NFCF_SERVICE" />
    </intent-filter>
    <meta-data android:name=
            "android.nfc.cardemulation.host_nfcf_service"
               android:resource="@xml/felica_service" />
</service>
```

---

## 小结

本章从 13.56 MHz 的射频一路向上到面向应用的 API，全面剖析了 Android 的 NFC 协议栈：

**架构** —— NFC 协议栈是一个分层系统，包括 AIDL HAL（`INfc`）、libnfc-nci 的 NCI 协议库、JNI 桥（`NativeNfcManager`）、核心的 `NfcService` 守护服务，以及公开的 `NfcAdapter` API。整个协议栈以 Mainline APEX 模块（`com.android.nfcservices`）形式分发。

**NfcService** —— 核心协调者，管理 NFC 硬件生命周期、依赖屏幕状态的轮询、消息处理器循环、标签发现、卡模拟以及路由表更新。

**NFC HAL** —— AIDL HAL（`android.hardware.nfc.INfc`）提供 11 个方法的接口，覆盖 NCI 主机操作。`NfcConfig` 承载硬件特定的路由与配置。回调（`INfcClientCallback`）投递 NCI 数据与生命周期事件。

**NDEF** —— NFC 数据交换格式把带类型的载荷（URI、文本、MIME、自定义）编码进 `NdefMessage`/`NdefRecord` 结构。3 位的 TNF 字段加上类型字节标识载荷格式。URI 前缀压缩可为标签节省字节。

**标签分发** —— Android 通过三层 Intent 链分发标签：`ACTION_NDEF_DISCOVERED`（最具体）、`ACTION_TECH_DISCOVERED`（技术匹配）与 `ACTION_TAG_DISCOVERED`（兜底）。前台分发与读取器模式为前台 Activity 提供独占的标签访问。

**HCE** —— 主机卡模拟让应用可以模拟 ISO-DEP 智能卡。`HostApduService` 处理 APDU 命令，`CardEmulationManager` 编排 AID 路由，`AidRoutingManager` 编程 NFCC 路由表。观察模式可在卡激活之前实现轮询环检测。

**安全元件** —— eSE 与 UICC 安全元件为高安全等级凭据提供硬件隔离的执行环境。OMAPI 提供应用访问通路。离主机卡模拟把事务直接路由到 SE。

**NFC-F 与 NFC-V** —— FeliCa（NFC-F）支持包括经 `NfcF` 的读取器模式，以及经 `HostNfcFService` 的主机模拟。NFC-V（ISO 15693）为库存与工业标签提供更远距离的通信。

**Android 17** —— NFC Mainline 模块新增三项特性。第一是 **Tap to X**（由 `PERFORM_GESTURE_EXCHANGE` 把关、位于 `tap_to_x` 标志之后的 `NfcGestureExchangeCallbackListener`／手势交换 API）。第二是 `allowOneTransaction()` 这一单次触碰的观察模式放行机制。第三是**钱包角色关联包**（`PROPERTY_ALLOW_SHARED_ROLE_PRIORITY`），它让 `ROLE_WALLET` 持有者可以把路由优先权与同级包共享。几乎每一项变更都由 `packages/modules/Nfc/flags/flags.aconfig` 中的一个 aconfig 标志控制。

值得重点研读的关键源文件：

| 文件 | 路径 |
|------|------|
| NfcService | `packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcService.java` |
| NfcDispatcher | `packages/modules/Nfc/NfcNci/src/com/android/nfc/NfcDispatcher.java` |
| DeviceHost | `packages/modules/Nfc/NfcNci/src/com/android/nfc/DeviceHost.java` |
| NfcAdapter | `packages/modules/Nfc/framework/java/android/nfc/NfcAdapter.java` |
| NdefRecord | `packages/modules/Nfc/framework/java/android/nfc/NdefRecord.java` |
| CardEmulationManager | `packages/modules/Nfc/NfcNci/src/com/android/nfc/cardemulation/CardEmulationManager.java` |
| HostEmulationManager | `packages/modules/Nfc/NfcNci/src/com/android/nfc/cardemulation/HostEmulationManager.java` |
| AidRoutingManager | `packages/modules/Nfc/NfcNci/src/com/android/nfc/cardemulation/AidRoutingManager.java` |
| NativeNfcManager | `packages/modules/Nfc/NfcNci/nci/src/com/android/nfc/dhimpl/NativeNfcManager.java` |
| INfc.aidl | `hardware/interfaces/nfc/aidl/aidl_api/android.hardware.nfc/current/android/hardware/nfc/INfc.aidl` |
| NfcConfig.aidl | `hardware/interfaces/nfc/aidl/aidl_api/android.hardware.nfc/current/android/hardware/nfc/NfcConfig.aidl` |
