---
title: "第 42 章：DRM 与内容保护"
description: "数字版权管理（DRM，Digital Rights Management）是 Android 中商业上最关键的子系统之一。用户可以拿 Netflix 看一部电影、在 Google Play 上租一部片，或通过某个高级应用观看体育直播。每一次，DRM 框架都在静默地协商许可证、解密内容、执行输出保护策略，而用户对此..."
pubDate: 2026-11-06T14:15:44
---

# 第 42 章：DRM 与内容保护

数字版权管理（DRM，Digital Rights Management）是 Android 中商业上最关键的子系统之一。用户可以拿 Netflix 看一部电影、在 Google Play 上租一部片，或通过某个高级应用观看体育直播。每一次，DRM 框架都在静默地协商许可证、解密内容、执行输出保护策略，而用户对此毫无感知。

本章剖析 Android 的 DRM 架构：从 Java API 表面出发，向下穿过原生框架，再跨过 HAL 边界，最终落到执行实际密码学操作的、由厂商提供的插件实现。

我们先给出高层架构概览（42.1 节），然后追踪应用直接打交道的框架代码（42.2 节）。接着考察厂商插件必须实现的稳定 AIDL HAL 契约（42.3 节）。之后讨论几乎每台 Android 设备都会搭载的 Widevine DRM 系统（42.4 节）。再逐行走一遍 ClearKey 参考插件（42.5 节）。

随后进入安全编解码路径——它保护解密后的帧不被明文抓取（42.6 节）。再讲度量与日志基础设施，它使诊断成为可能而又不泄露受保护素材（42.7 节）。之后是 Android 17 的 DRM HAL 变更：AIDL 接口冻结在版本 2，并新增了密钥句柄（key handle）解密-解码快速路径（42.8 节）。最后是动手练习（42.9 节）。

---

## 42.1 DRM 架构概览

### 42.1.1 DRM 要解决的问题

内容所有者——电影制片厂、唱片公司、体育联盟——在严格条件下把素材授权给流媒体服务：

- 内容在传输中与静态存储时都必须加密。
- 解密密钥绝不能暴露给应用代码。
- 解密后的帧必须防止被截屏或经 HDMI 盗录。
- 播放结束时系统必须向许可证服务器回报（安全停止）。

Android 的 DRM 框架正是为满足这些要求而存在，同时还要向应用开发者呈现一套干净、与具体 DRM 方案无关的 API。

### 42.1.2 核心组件

DRM 子系统由四个主要组件构成，横跨应用进程、厂商 HAL 进程与可信执行环境：

1. **MediaDrm**——应用用来协商许可证与管理会话的 Java API，位于应用进程。

2. **MediaCrypto**——配套的 Java API，把 DRM 会话桥接到编解码器。它同样位于应用进程，但把所有密码学工作经 Binder 委派出去。

3. **DRM 框架（libmediadrm）**——原生 C++ 层。它经 `libmedia_jni` 加载进客户端进程本身。它通过 Binder 把调用路由到合适的 HAL 后端，用 `DrmSessionManager` 管理会话，并采集度量。（较早版本把这一层放在独立的 `mediadrmserver` 进程中；该进程现已不存在。）

4. **DRM HAL 插件**——由厂商提供的 AIDL 服务（或旧式 HIDL 服务），实现真正的密码学操作，运行在自己的进程中。

```
Source path: frameworks/av/drm/          (native framework)
             frameworks/base/media/java/android/media/MediaDrm.java   (Java API)
             hardware/interfaces/drm/    (HAL definitions)
             frameworks/av/drm/mediadrm/plugins/clearkey/   (reference plugin)
```

### 42.1.3 端到端架构图

下面的图展示了受 DRM 保护的播放会话如何从应用层经框架一路下到由硬件支持的插件：

```mermaid
graph TB
    subgraph "Application Process"
        APP[Application]
        MD["MediaDrm<br/>Java API"]
        MC["MediaCrypto<br/>Java API"]
        CODEC[MediaCodec]
        EXT[MediaExtractor]
    end

    subgraph "App Process - libmediadrm"
        DH["DrmHal<br/>libmediadrm"]
        CH["CryptoHal<br/>libmediadrm"]
        DSM[DrmSessionManager]
        DML[DrmMetricsLogger]
    end

    subgraph "DRM HAL Process"
        DF[IDrmFactory]
        DP[IDrmPlugin]
        CP[ICryptoPlugin]
    end

    subgraph "Trusted Execution Environment"
        TEE[OEMCrypto / TrustZone]
    end

    APP --> MD
    APP --> MC
    APP --> CODEC
    APP --> EXT

    MD -->|JNI| DH
    MC -->|JNI| CH
    CODEC -->|secure buffer| CH

    DH --> DSM
    DH --> DML
    DH -->|AIDL / HIDL| DF
    DF --> DP
    DF --> CP

    CH -->|AIDL / HIDL| CP

    DP -->|TEE calls| TEE
    CP -->|secure decrypt| TEE
```

### 42.1.4 基于 UUID 的方案选择

每种 DRM 方案都由一个 16 字节的 UUID 标识。应用遇到受 DRM 保护的内容时，会从内容元数据中读出方案 UUID——通常位于 ISO BMFF 容器的 PSSH box 中，或位于 DASH 清单的 ContentProtection 元素中。接着应用查询设备是否支持该方案：

```java
// Source: frameworks/base/media/java/android/media/MediaDrm.java
public static final boolean isCryptoSchemeSupported(@NonNull UUID uuid) {
    return isCryptoSchemeSupportedNative(getByteArrayFromUUID(uuid), null,
            SECURITY_LEVEL_UNKNOWN);
}
```

常见的 UUID 包括：

| DRM 方案 | UUID |
|-----------|------|
| Widevine | `edef8ba9-79d6-4ace-a3c8-27dcd51d21ed` |
| ClearKey (Common PSSH) | `1077efec-c0b2-4d02-ace3-3c1e52e2fb4b` |
| ClearKey | `e2719d58-a985-b3c9-781a-b030af78d30e` |
| PlayReady | `9a04f079-9840-4286-ab92-e65be0885f95` |

在原生层，`DrmHal::isCryptoSchemeSupported()` 先尝试 AIDL HAL，再回落到旧式 HIDL HAL：

```cpp
// Source: frameworks/av/drm/libmediadrm/DrmHal.cpp
DrmStatus DrmHal::isCryptoSchemeSupported(const uint8_t uuid[16],
        const String8& mimeType,
        DrmPlugin::SecurityLevel securityLevel,
        bool* result) {
    DrmStatus statusResult =
            mDrmHalAidl->isCryptoSchemeSupported(uuid, mimeType,
                    securityLevel, result);
    if (*result) return statusResult;
    return mDrmHalHidl->isCryptoSchemeSupported(uuid, mimeType,
            securityLevel, result);
}
```

这种双后端模式贯穿 `DrmHal` 的每一个方法。该类先尝试 AIDL；若 AIDL HAL 未初始化完成（`initCheck() != OK`），就落到 HIDL。

### 42.1.5 播放生命周期

一次完整的 DRM 播放会话按以下步骤进行：

```mermaid
sequenceDiagram
    participant App
    participant MediaDrm
    participant LicenseServer
    participant MediaCrypto
    participant MediaCodec
    participant DrmPlugin as IDrmPlugin (HAL)
    participant CryptoPlugin as ICryptoPlugin (HAL)

    App->>MediaDrm: new MediaDrm(schemeUUID)
    App->>MediaDrm: openSession()
    MediaDrm->>DrmPlugin: openSession(securityLevel)
    DrmPlugin-->>MediaDrm: sessionId

    App->>MediaDrm: getKeyRequest(sessionId, initData, mimeType, keyType)
    MediaDrm->>DrmPlugin: getKeyRequest(scope, initData, mimeType, keyType, params)
    DrmPlugin-->>MediaDrm: KeyRequest{data, defaultUrl, requestType}

    App->>LicenseServer: POST keyRequest.data
    LicenseServer-->>App: keyResponse

    App->>MediaDrm: provideKeyResponse(sessionId, keyResponse)
    MediaDrm->>DrmPlugin: provideKeyResponse(scope, response)
    DrmPlugin-->>MediaDrm: keySetId

    App->>MediaCrypto: new MediaCrypto(schemeUUID, sessionId)
    MediaCrypto->>CryptoPlugin: setMediaDrmSession(sessionId)

    App->>MediaCodec: configure(format, surface, mediaCrypto, flags)

    loop For each encrypted sample
        App->>MediaCodec: queueSecureInputBuffer(cryptoInfo)
        MediaCodec->>CryptoPlugin: decrypt(DecryptArgs)
        CryptoPlugin-->>MediaCodec: bytesDecrypted
        MediaCodec-->>App: dequeueOutputBuffer()
    end

    App->>MediaDrm: closeSession(sessionId)
    MediaDrm->>DrmPlugin: closeSession(sessionId)
```

### 42.1.6 安全级别

DRM HAL 定义了一套安全级别层次，用来表达设备 DRM 实现的健壮程度。这些值定义在 AIDL 枚举中：

```
// Source: hardware/interfaces/drm/aidl/android/hardware/drm/SecurityLevel.aidl
enum SecurityLevel {
    UNKNOWN,            // Unable to determine the security level
    SW_SECURE_CRYPTO,   // Software-based whitebox crypto
    SW_SECURE_DECODE,   // Software-based whitebox crypto + obfuscated decoder
    HW_SECURE_CRYPTO,   // Key management and crypto in TEE
    HW_SECURE_DECODE,   // Key management, crypto, and decode in TEE
    HW_SECURE_ALL,      // All processing in TEE (compressed + uncompressed)
    DEFAULT,            // Highest supported level on the device
}
```

更高的安全级别可解锁更高质量的内容。具备 `HW_SECURE_ALL` 的设备可以从高端服务流式播放 4K HDR，而只能到 `SW_SECURE_CRYPTO` 的设备可能被限制在标清分辨率。安全级别在打开会话时选定：

```java
// Source: frameworks/base/media/java/android/media/MediaDrm.java
public byte[] openSession(@SecurityLevel int level) throws
        NotProvisionedException, ResourceBusyException {
    byte[] sessionId = openSessionNative(level);
    mPlaybackComponentMap.put(ByteBuffer.wrap(sessionId),
            new PlaybackComponent(sessionId));
    return sessionId;
}
```

---

## 42.2 DRM 框架

### 42.2.1 源码树布局

DRM 框架代码位于 `frameworks/av/drm/` 下，划分为若干库与目录：

```
frameworks/av/drm/
    drmserver/              Legacy DRM manager service (OMA DRM)
        DrmManager.cpp
        DrmManagerService.cpp
        main_drmserver.cpp
    libdrmframework/        Client library for legacy DRM APIs
    libmediadrm/            Core DRM framework library
        DrmHal.cpp          Unified AIDL+HIDL entry point
        DrmHalAidl.cpp      AIDL HAL wrapper (44 KB)
        DrmHalHidl.cpp      HIDL HAL wrapper (56 KB)
        CryptoHal.cpp       Crypto routing layer
        CryptoHalAidl.cpp   AIDL Crypto wrapper
        CryptoHalHidl.cpp   HIDL Crypto wrapper
        DrmHalListener.cpp  Event dispatch from HAL to framework
        DrmSessionManager.cpp  Session lifecycle & resource management
        DrmMetrics.cpp       Metrics collection (protobuf)
        DrmMetricsLogger.cpp Metrics reporting to MediaMetrics
        DrmMetricsConsumer.cpp  Metrics export to PersistableBundle
        DrmUtils.cpp         HAL discovery and factory creation
        DrmPluginPath.cpp    Plugin shared-library path resolution
        SharedLibrary.cpp    dlopen/dlsym wrapper
        DrmStatus.cpp        Status code translation
        PluginMetricsReporting.cpp
        include/mediadrm/    Public headers
    libmediadrmrkp/          Remote key provisioning support
    mediadrm/
        plugins/
            clearkey/        Reference ClearKey plugin
    mediacas/                Conditional Access System (CAS)
    common/                  Common utilities
```

### 42.2.2 MediaDrm Java API

`MediaDrm` 类（`frameworks/base/media/java/android/media/MediaDrm.java`）是面向应用的主要 API。它是一个实现 `AutoCloseable` 的 `final class`，这意味着开发者使用 try-with-resources 时，会话会被自动清理。

关键设计特征：

- **基于 UUID 构造**：一个 `MediaDrm` 实例对应一种特定的 DRM 方案 UUID。构造函数调用 `native_setup()`，后者连接到原生 `DrmMetricsLogger` 层，由该层再创建 `DrmHal` 对象。

- **面向会话**：所有密钥操作（getKeyRequest、provideKeyResponse 等）都作用于一个由不透明字节数组会话 ID 标识的会话。

- **监听器架构**：该类支持四种监听器类型，全部由通用的 `ConcurrentHashMap<Integer, ListenerWithExecutor>` 模式管理：

```java
// Source: frameworks/base/media/java/android/media/MediaDrm.java
private static final int DRM_EVENT = 200;
private static final int EXPIRATION_UPDATE = 201;
private static final int KEY_STATUS_CHANGE = 202;
private static final int SESSION_LOST_STATE = 203;

private final Map<Integer, ListenerWithExecutor> mListenerMap =
        new ConcurrentHashMap<>();
```

事件经 `IDrmPluginListener` AIDL 接口从 HAL 插件发出，穿过原生 `DrmHalListener` 类，抵达 `MediaDrm.postEventFromNative()`。该方法再把它们派发给已注册的监听器，并在合适的执行器上运行。

### 42.2.3 密钥请求/响应流程

许可证获取过程是 DRM 运作的核心。应用调用 `getKeyRequest()` 生成一份不透明的许可证请求，通过 HTTPS 发给许可证服务器，再把响应回填给框架：

```mermaid
graph LR
    subgraph Application
        A1[getKeyRequest] --> A2[HTTP POST to license server]
        A2 --> A3[provideKeyResponse]
    end

    subgraph FW["Framework - libmediadrm"]
        A1 -.->|JNI| F1[DrmHal::getKeyRequest]
        A3 -.->|JNI| F2[DrmHal::provideKeyResponse]
    end

    subgraph HP["HAL Plugin"]
        F1 -.->|AIDL| H1[IDrmPlugin::getKeyRequest]
        F2 -.->|AIDL| H2[IDrmPlugin::provideKeyResponse]
    end
```

密钥类型决定行为：

| 密钥类型 | 常量 | 行为 |
|----------|----------|----------|
| 流式 | `KEY_TYPE_STREAMING` (1) | 密钥仅在当前会话内有效 |
| 离线 | `KEY_TYPE_OFFLINE` (2) | 密钥持久化，可离线使用 |
| 释放 | `KEY_TYPE_RELEASE` (3) | 释放此前保存的离线密钥 |

插件返回的密钥请求类型告诉应用接下来该做什么：

| 请求类型 | 常量 | 含义 |
|-------------|----------|---------|
| 初始 | `REQUEST_TYPE_INITIAL` (0) | 首次许可证请求 |
| 续期 | `REQUEST_TYPE_RENEWAL` (1) | 到期前续订许可证 |
| 释放 | `REQUEST_TYPE_RELEASE` (2) | 密钥释放确认 |
| 无 | `REQUEST_TYPE_NONE` (3) | 密钥已可用，无需请求 |
| 更新 | `REQUEST_TYPE_UPDATE` (4) | 密钥已载入但需要更新值 |

### 42.2.4 MediaCrypto——编解码器桥

`MediaCrypto`（`frameworks/base/media/java/android/media/MediaCrypto.java`）是 DRM 会话与媒体编解码器之间的桥梁。它比 `MediaDrm` 简单：

```java
// Source: frameworks/base/media/java/android/media/MediaCrypto.java
public final class MediaCrypto {
    public static final boolean isCryptoSchemeSupported(@NonNull UUID uuid);
    public MediaCrypto(@NonNull UUID uuid, @NonNull byte[] sessionId)
            throws MediaCryptoException;
    public final native boolean requiresSecureDecoderComponent(
            @NonNull String mime);
    public final native void setMediaDrmSession(@NonNull byte[] sessionId)
            throws MediaCryptoException;
    public native final void release();
}
```

`requiresSecureDecoderComponent()` 方法至关重要：它向 HAL 插件查询当前安全策略是否要求安全解码器。若返回 `true`，应用就必须用 `CONFIGURE_FLAG_SECURE` 标志配置 `MediaCodec`。这样，所有解码后的帧都留在安全（受保护）内存中，CPU 无法读取。

### 42.2.5 DrmHal——统一的原生入口

`DrmHal` 类（`frameworks/av/drm/libmediadrm/DrmHal.cpp`）是一层薄路由，同时持有 AIDL 后端（`DrmHalAidl`）与 HIDL 后端（`DrmHalHidl`）：

```cpp
// Source: frameworks/av/drm/libmediadrm/DrmHal.cpp
DrmHal::DrmHal() {
    mDrmHalHidl = sp<DrmHalHidl>::make();
    mDrmHalAidl = sp<DrmHalAidl>::make();
}
```

每个 API 方法都遵循同一模式：先试 AIDL，再落到 HIDL。这一设计在偏好现代设备上的新 AIDL 接口的同时，保持了对搭载 HIDL DRM HAL 设备的向后兼容。

`createPlugin()` 方法演示了这种穿透式回落：

```cpp
// Source: frameworks/av/drm/libmediadrm/DrmHal.cpp
DrmStatus DrmHal::createPlugin(const uint8_t uuid[16],
        const String8& appPackageName) {
    return mDrmHalAidl->createPlugin(uuid, appPackageName) == OK
                   ? DrmStatus(OK)
                   : mDrmHalHidl->createPlugin(uuid, appPackageName);
}
```

### 42.2.6 DrmHalAidl——AIDL 后端

`DrmHalAidl`（`frameworks/av/drm/libmediadrm/DrmHalAidl.cpp`）包含完整的 AIDL 集成逻辑。初始化时，它用 `AServiceManager` 发现 AIDL DRM HAL 服务，查询其支持的加密方案，并通过工厂实例化合适的 `IDrmPlugin`：

该类在框架的旧式类型（`Vector<uint8_t>`、`KeyedVector<String8, String8>`）与 AIDL 类型（`std::vector<uint8_t>`、`std::vector<KeyValue>`）之间做大量类型转换。`toKeyValueVector()` 与 `toKeyedVector()` 辅助函数负责这一翻译：

```cpp
// Source: frameworks/av/drm/libmediadrm/DrmHalAidl.cpp
static std::vector<KeyValue> toKeyValueVector(
        const KeyedVector<String8, String8>& keyedVector) {
    std::vector<KeyValue> stdKeyedVector;
    for (size_t i = 0; i < keyedVector.size(); i++) {
        KeyValue keyValue;
        keyValue.key = toStdString(keyedVector.keyAt(i));
        keyValue.value = toStdString(keyedVector.valueAt(i));
        stdKeyedVector.push_back(keyValue);
    }
    return stdKeyedVector;
}
```

### 42.2.7 DrmSessionManager——资源管理

`DrmSessionManager`（`frameworks/av/drm/libmediadrm/DrmSessionManager.cpp`）管理 DRM 会话生命周期，并与 Android 的 `ResourceManagerService` 集成，以便在资源压力下支持会话回收。

```mermaid
graph TB
    subgraph DrmSessionManager
        SM["DrmSessionManager<br/>Singleton"]
    end

    subgraph ResourceManagerService
        RMS[IResourceManagerService]
    end

    subgraph DP_SG["DRM Plugin"]
        DP[IDrmPlugin sessions]
    end

    SM -->|addResource| RMS
    SM -->|removeResource| RMS
    RMS -->|reclaimResource| SM
    SM -->|closeSession| DP
```

会话打开时，管理器把它作为 `kDrmSession` 资源注册到 `ResourceManagerService`：

```cpp
// Source: frameworks/av/drm/libmediadrm/DrmSessionManager.cpp
static std::vector<MediaResourceParcel> toResourceVec(
        const Vector<uint8_t> &sessionId, int64_t value) {
    using Type = aidl::android::media::MediaResourceType;
    using SubType = aidl::android::media::MediaResourceSubType;
    std::vector<MediaResourceParcel> resources;
    MediaResourceParcel resource{
            Type::kDrmSession, SubType::kUnspecifiedSubType,
            toStdVec<>(sessionId), value};
    resources.push_back(resource);
    return resources;
}
```

若系统的 DRM 会话资源吃紧，`ResourceManagerService` 可以从优先级较低的应用回收会话。许多 DRM 实现都限制并发会话数。该服务回调 `DrmSessionManager`，后者关闭会话并向应用投递 `EVENT_SESSION_RECLAIMED` 事件。

### 42.2.8 DRM 事件传播

事件经 `IDrmPluginListener` AIDL 回调接口与 `DrmHalListener` 类，从 HAL 插件穿过框架抵达应用：

```mermaid
sequenceDiagram
    participant Plugin as IDrmPlugin (HAL)
    participant Listener as DrmHalListener
    participant Metrics as MediaDrmMetrics
    participant Client as IDrmClient
    participant MediaDrm as MediaDrm (Java)
    participant App as Application

    Plugin->>Listener: onKeysChange(sessionId, keyStatusList, hasNewUsableKey)
    Listener->>Metrics: mKeyStatusChangeCounter.Increment()
    Listener->>Client: sendKeysChange(sessionId, keyStatusList, hasNewUsableKey)
    Client->>MediaDrm: postEventFromNative(KEY_STATUS_CHANGE, ...)
    MediaDrm->>App: onKeyStatusChange(md, sessionId, keyInfo, hasNewUsableKey)
```

`DrmHalListener` 把 AIDL 事件类型转换为框架事件类型，并为每个事件递增度量计数器：

```cpp
// Source: frameworks/av/drm/libmediadrm/DrmHalListener.cpp
::ndk::ScopedAStatus DrmHalListener::onEvent(
        EventTypeAidl eventTypeAidl,
        const std::vector<uint8_t>& sessionId,
        const std::vector<uint8_t>& data) {
    mMetrics->mEventCounter.Increment((uint32_t)eventTypeAidl);
    // ... dispatch to IDrmClient ...
}
```

### 42.2.9 预置（Provisioning）

某些 DRM 方案要求设备预置——即设备从预置服务器取得唯一凭据的一次性过程。该流程与密钥请求/响应模式类似：

1. 应用从 `openSession()` 或 `getKeyRequest()` 捕获 `NotProvisionedException`。
2. 它调用 `getProvisionRequest()` 获取一份不透明的预置请求。
3. 它把请求发到预置服务器 URL。
4. 它通过 `provideProvisionResponse()` 回填响应。

HAL 方法签名为：

```
// Source: hardware/interfaces/drm/aidl/android/hardware/drm/IDrmPlugin.aidl
ProvisionRequest getProvisionRequest(
        in String certificateType, in String certificateAuthority);
```

### 42.2.10 安全停止（Secure Stops）

安全停止是强制执行并发流数限制的机制。每当一个 `MediaCrypto` 对象被创建，HAL 插件就持久化一条带签名的会话记录。播放结束时，应用取出这些记录并转给许可证服务器，由后者确认该会话确实已终止。

`IDrmPlugin` 接口提供完整的安全停止生命周期：

| 方法 | 用途 |
|--------|---------|
| `getSecureStops()` | 获取所有安全停止记录 |
| `getSecureStopIds()` | 获取所有安全停止 ID |
| `getSecureStop(SecureStopId)` | 按 ID 获取特定安全停止 |
| `releaseSecureStops(OpaqueData)` | 在服务器确认后释放 |
| `releaseSecureStop(SecureStopId)` | 按 ID 释放特定停止记录 |
| `releaseAllSecureStops()` | 释放全部停止记录 |
| `removeSecureStop(SecureStopId)` | 不经服务器确认即移除 |
| `removeAllSecureStops()` | 不经确认移除全部 |

### 42.2.11 离线许可证管理

离线许可证让内容无需网络连接即可播放。框架提供了管理离线许可证状态的方法：

```java
// Key flow for offline licenses
// 1. Request offline keys
KeyRequest request = mediaDrm.getKeyRequest(
    sessionId, initData, mimeType, MediaDrm.KEY_TYPE_OFFLINE, null);

// 2. After providing response, receive a keySetId
byte[] keySetId = mediaDrm.provideKeyResponse(sessionId, response);

// 3. Later, restore offline keys to a new session
mediaDrm.restoreKeys(newSessionId, keySetId);

// 4. Query offline license state
List<KeySetId> offlineKeys = mediaDrm.getOfflineLicenseKeySetIds();
OfflineLicenseState state = mediaDrm.getOfflineLicenseState(keySetId);
```

`IDrmPlugin` HAL 支持三种离线许可证状态：

```
// Source: hardware/interfaces/drm/aidl/android/hardware/drm/OfflineLicenseState.aidl
enum OfflineLicenseState {
    UNKNOWN,   // Unable to determine the state
    USABLE,    // Keys available for decryption
    INACTIVE,  // Marked for release but not yet confirmed
}
```

### 42.2.12 插件路径解析

基于共享库的旧式插件从运行时决定的厂商专用路径加载：

```cpp
// Source: frameworks/av/drm/libmediadrm/DrmPluginPath.cpp
const char* getDrmPluginPath() {
    char value[PROPERTY_VALUE_MAX];
    if (property_get("drm.64bit.enabled", value, NULL) == 0) {
        return "/vendor/lib/mediadrm";
    } else {
        return "/vendor/lib64/mediadrm";
    }
}
```

`SharedLibrary` 类封装 `dlopen`/`dlsym`：

```cpp
// Source: frameworks/av/drm/libmediadrm/SharedLibrary.cpp
SharedLibrary::SharedLibrary(const String8 &path) {
    mLibHandle = dlopen(path.c_str(), RTLD_NOW);
}

void *SharedLibrary::lookup(const char *symbol) const {
    if (!mLibHandle) return NULL;
    (void)dlerror();
    return dlsym(mLibHandle, symbol);
}
```

### 42.2.13 HAL 发现

`DrmUtils` 模块（`frameworks/av/drm/libmediadrm/DrmUtils.cpp`）负责发现可用的 DRM HAL 服务。它同时枚举 AIDL 与 HIDL 服务注册。

对于 HIDL，它遍历 IDrmFactory 接口的所有版本（1.0 到 1.4）：

```cpp
// Source: frameworks/av/drm/libmediadrm/DrmUtils.cpp
template <typename Hal, typename V, typename M>
void MakeHidlFactories(const uint8_t uuid[16], V& factories,
                       M& instances) {
    sp<HServiceManager> serviceManager =
            HServiceManager::getService();
    serviceManager->listManifestByInterface(
            Hal::descriptor,
            [&](const hidl_vec<hidl_string>& registered) {
                for (const auto& instance : registered) {
                    auto factory = Hal::getService(instance);
                    if (factory != nullptr) {
                        instances[instance.c_str()] = Hal::descriptor;
                        // ... check UUID support ...
                    }
                }
            });
}
```

对于 AIDL，发现过程用 `AServiceManager` 查找已注册的 `android.hardware.drm.IDrmFactory` 服务。

---

## 42.3 DRM HAL

### 42.3.1 HAL 演进

DRM HAL 经历了显著演进：

| 版本 | 接口 | 传输方式 | 说明 |
|---------|-----------|-----------|-------|
| 1.0 | HIDL | hwbinder | 初始 DRM HAL |
| 1.1 | HIDL | hwbinder | 新增度量（DrmMetricGroup） |
| 1.2 | HIDL | hwbinder | 新增离线许可证管理 |
| 1.3 | HIDL | hwbinder | 新增 `IDrmFactory::getSupportedCryptoSchemes()` |
| 1.4 | HIDL | hwbinder | 新增带安全级别的 `requiresSecureDecoder`、`setPlaybackId` 与 `getLogMessages` |
| AIDL V1 | AIDL | binder | 统一接口，稳定 AIDL（已冻结） |
| AIDL V2（17 中的当前版本） | AIDL | binder | 已冻结；新增 `ICryptoPlugin::getKeyHandle()` 与 `KeyHandleResult` parcelable |

`hardware/interfaces/drm/aidl/Android.bp` 中的 `versions_with_info` 块同时声明了 V1 与 V2。该接口标注为 `frozen: true`，因此 Android 17 以 V2 作为已冻结的最高 AIDL DRM HAL 版本。42.8 节将详细说明 V2 相对 V1 增加了什么，以及框架如何按版本门控这个新方法。

目录结构反映了这一演进：

```
hardware/interfaces/drm/
    1.0/        HIDL v1.0 interfaces
    1.1/        HIDL v1.1 interfaces (extends 1.0)
    1.2/        HIDL v1.2 interfaces (extends 1.1)
    1.3/        HIDL v1.3 interfaces (extends 1.2)
    1.4/        HIDL v1.4 interfaces (extends 1.3)
    aidl/       Stable AIDL interfaces (current)
        android/hardware/drm/   AIDL source files
        aidl_api/               Frozen API snapshots
        vts/                    Vendor Test Suite
    common/     Shared utilities
```

### 42.3.2 IDrmFactory——入口点

`IDrmFactory` 是 HAL 的入口点。厂商注册一个或多个工厂服务；框架发现它们，并用工厂创建插件实例：

```
// Source: hardware/interfaces/drm/aidl/android/hardware/drm/IDrmFactory.aidl
@VintfStability
interface IDrmFactory {
    @nullable IDrmPlugin createDrmPlugin(
            in Uuid uuid, in String appPackageName);

    @nullable ICryptoPlugin createCryptoPlugin(
            in Uuid uuid, in byte[] initData);

    CryptoSchemes getSupportedCryptoSchemes();
}
```

`CryptoSchemes` 返回值告诉框架该工厂支持哪些 UUID 与内容类型，同时给出每种 MIME 类型的最小与最大安全级别：

```mermaid
classDiagram
    class IDrmFactory {
        +createDrmPlugin(uuid, packageName) IDrmPlugin
        +createCryptoPlugin(uuid, initData) ICryptoPlugin
        +getSupportedCryptoSchemes() CryptoSchemes
    }

    class CryptoSchemes {
        +uuids: List~Uuid~
        +mimeTypes: List~SupportedContentType~
    }

    class SupportedContentType {
        +mime: String
        +minLevel: SecurityLevel
        +maxLevel: SecurityLevel
    }

    IDrmFactory --> CryptoSchemes
    CryptoSchemes --> SupportedContentType
```

### 42.3.3 IDrmPlugin——会话与密钥管理

`IDrmPlugin` 接口（`hardware/interfaces/drm/aidl/android/hardware/drm/IDrmPlugin.aidl`）是 DRM HAL 中最大的接口。它覆盖会话管理、密钥获取、预置、安全停止、属性访问、密码学操作与度量。

完整方法清单如下。

**会话管理：**

| 方法 | 签名 |
|--------|-----------|
| `openSession` | `byte[] openSession(in SecurityLevel securityLevel)` |
| `closeSession` | `void closeSession(in byte[] sessionId)` |
| `getNumberOfSessions` | `NumberOfSessions getNumberOfSessions()` |
| `getSecurityLevel` | `SecurityLevel getSecurityLevel(in byte[] sessionId)` |

**密钥管理：**

| 方法 | 签名 |
|--------|-----------|
| `getKeyRequest` | `KeyRequest getKeyRequest(in byte[] scope, in byte[] initData, in String mimeType, in KeyType keyType, in KeyValue[] optionalParameters)` |
| `provideKeyResponse` | `KeySetId provideKeyResponse(in byte[] scope, in byte[] response)` |
| `removeKeys` | `void removeKeys(in byte[] sessionId)` |
| `restoreKeys` | `void restoreKeys(in byte[] sessionId, in KeySetId keySetId)` |
| `queryKeyStatus` | `List<KeyValue> queryKeyStatus(in byte[] sessionId)` |

**预置：**

| 方法 | 签名 |
|--------|-----------|
| `getProvisionRequest` | `ProvisionRequest getProvisionRequest(in String certificateType, in String certificateAuthority)` |
| `provideProvisionResponse` | `ProvideProvisionResponseResult provideProvisionResponse(in byte[] response)` |

**安全停止：**

| 方法 | 签名 |
|--------|-----------|
| `getSecureStops` | `List<SecureStop> getSecureStops()` |
| `getSecureStopIds` | `List<SecureStopId> getSecureStopIds()` |
| `getSecureStop` | `SecureStop getSecureStop(in SecureStopId secureStopId)` |
| `releaseSecureStops` | `void releaseSecureStops(in OpaqueData ssRelease)` |
| `releaseSecureStop` | `void releaseSecureStop(in SecureStopId secureStopId)` |
| `releaseAllSecureStops` | `void releaseAllSecureStops()` |
| `removeSecureStop` | `void removeSecureStop(in SecureStopId secureStopId)` |
| `removeAllSecureStops` | `void removeAllSecureStops()` |

**离线许可证管理：**

| 方法 | 签名 |
|--------|-----------|
| `getOfflineLicenseKeySetIds` | `List<KeySetId> getOfflineLicenseKeySetIds()` |
| `getOfflineLicenseState` | `OfflineLicenseState getOfflineLicenseState(in KeySetId keySetId)` |
| `removeOfflineLicense` | `void removeOfflineLicense(in KeySetId keySetId)` |

**属性：**

| 方法 | 签名 |
|--------|-----------|
| `getPropertyString` | `String getPropertyString(in String propertyName)` |
| `getPropertyByteArray` | `byte[] getPropertyByteArray(in String propertyName)` |
| `setPropertyString` | `void setPropertyString(in String propertyName, in String value)` |
| `setPropertyByteArray` | `void setPropertyByteArray(in String propertyName, in byte[] value)` |

标准属性名包括：

| 属性 | 类型 | 说明 |
|----------|------|-------------|
| `vendor` | String | DRM 方案厂商名 |
| `version` | String | DRM 方案版本 |
| `description` | String | 人类可读描述 |
| `deviceUniqueId` | byte[] | 设备唯一标识符 |

**密码学操作：**

| 方法 | 签名 |
|--------|-----------|
| `encrypt` | `byte[] encrypt(in byte[] sessionId, in byte[] keyId, in byte[] input, in byte[] iv)` |
| `decrypt` | `byte[] decrypt(in byte[] sessionId, in byte[] keyId, in byte[] input, in byte[] iv)` |
| `sign` | `byte[] sign(in byte[] sessionId, in byte[] keyId, in byte[] message)` |
| `verify` | `boolean verify(in byte[] sessionId, in byte[] keyId, in byte[] message, in byte[] signature)` |
| `signRSA` | `byte[] signRSA(...)` |

**配置：**

| 方法 | 签名 |
|--------|-----------|
| `setCipherAlgorithm` | `void setCipherAlgorithm(in byte[] sessionId, in String algorithm)` |
| `setMacAlgorithm` | `void setMacAlgorithm(in byte[] sessionId, in String algorithm)` |
| `getHdcpLevels` | `HdcpLevels getHdcpLevels()` |
| `requiresSecureDecoder` | `boolean requiresSecureDecoder(in String mime, in SecurityLevel level)` |
| `setPlaybackId` | `void setPlaybackId(in byte[] sessionId, in String playbackId)` |

**度量与日志：**

| 方法 | 签名 |
|--------|-----------|
| `getMetrics` | `List<DrmMetricGroup> getMetrics()` |
| `getLogMessages` | `List<LogMessage> getLogMessages()` |

**监听器：**

| 方法 | 签名 |
|--------|-----------|
| `setListener` | `void setListener(in IDrmPluginListener listener)` |

### 42.3.4 ICryptoPlugin——解密引擎

`ICryptoPlugin` 接口（`hardware/interfaces/drm/aidl/android/hardware/drm/ICryptoPlugin.aidl`）处理内容样本的实际解密。它是一个更聚焦的接口：

```
// Source: hardware/interfaces/drm/aidl/android/hardware/drm/ICryptoPlugin.aidl
@VintfStability
interface ICryptoPlugin {
    int decrypt(in DecryptArgs args);
    List<LogMessage> getLogMessages();
    void notifyResolution(in int width, in int height);
    boolean requiresSecureDecoderComponent(in String mime);
    void setMediaDrmSession(in byte[] sessionId);
    void setSharedBufferBase(in SharedBuffer base);
    KeyHandleResult getKeyHandle(in byte[] keyId, in Mode mode);
}
```

`decrypt()` 方法是性能关键路径——播放期间每个加密媒体样本都要调用一次。`DecryptArgs` parcelable 把所有参数打包进一次 IPC 调用：

```
// Source: hardware/interfaces/drm/aidl/android/hardware/drm/DecryptArgs.aidl
parcelable DecryptArgs {
    boolean secure;          // Whether a secure decoder is being used
    byte[] keyId;            // Key ID for decryption
    byte[] iv;               // Initialization vector
    Mode mode;               // UNENCRYPTED, AES_CTR, AES_CBC, AES_CBC_CTS
    Pattern pattern;         // CENC pattern (encrypt/skip block counts)
    SubSample[] subSamples;  // Clear and encrypted byte ranges
    SharedBuffer source;     // Input buffer reference
    long offset;             // Offset into source buffer
    DestinationBuffer destination;  // Output buffer (secure or non-secure)
}
```

`DecryptArgs` 中的 `secure` 标志决定输出是进入普通共享内存缓冲（`nonsecureMemory`），还是写入安全缓冲句柄（`secureMemory`）。只有硬件合成器与安全视频解码器才能访问该句柄。

### 42.3.5 IDrmPluginListener——异步事件

`IDrmPluginListener` 接口允许 HAL 插件向框架通知异步事件：

```
// Source: hardware/interfaces/drm/aidl/android/hardware/drm/IDrmPluginListener.aidl
@VintfStability
interface IDrmPluginListener {
    oneway void onEvent(in EventType eventType,
            in byte[] sessionId, in byte[] data);
    oneway void onExpirationUpdate(in byte[] sessionId,
            in long expiryTimeInMS);
    oneway void onKeysChange(in byte[] sessionId,
            in KeyStatus[] keyStatusList,
            in boolean hasNewUsableKey);
    oneway void onSessionLostState(in byte[] sessionId);
}
```

所有方法都是 `oneway`（发出即返回），以免 HAL 因等待框架而阻塞。事件类型为：

```
// Source: hardware/interfaces/drm/aidl/android/hardware/drm/EventType.aidl
enum EventType {
    PROVISION_REQUIRED,  // Device needs provisioning
    KEY_NEEDED,          // App needs to request keys
    KEY_EXPIRED,         // Keys have expired
    VENDOR_DEFINED,      // Vendor-specific event
    SESSION_RECLAIMED,   // Session reclaimed by resource manager
}
```

### 42.3.6 状态码

DRM HAL 定义了一整套覆盖各种失败模式的 status 码：

```
// Source: hardware/interfaces/drm/aidl/android/hardware/drm/Status.aidl
enum Status {
    OK,
    ERROR_DRM_NO_LICENSE,
    ERROR_DRM_LICENSE_EXPIRED,
    ERROR_DRM_SESSION_NOT_OPENED,
    ERROR_DRM_CANNOT_HANDLE,
    ERROR_DRM_INVALID_STATE,
    BAD_VALUE,
    ERROR_DRM_NOT_PROVISIONED,
    ERROR_DRM_RESOURCE_BUSY,
    ERROR_DRM_INSUFFICIENT_OUTPUT_PROTECTION,
    ERROR_DRM_DEVICE_REVOKED,
    ERROR_DRM_DECRYPT,
    ERROR_DRM_UNKNOWN,
    ERROR_DRM_INSUFFICIENT_SECURITY,
    ERROR_DRM_FRAME_TOO_LARGE,
    ERROR_DRM_SESSION_LOST_STATE,
    ERROR_DRM_RESOURCE_CONTENTION,
    CANNOT_DECRYPT_ZERO_SUBSAMPLES,
    CRYPTO_LIBRARY_ERROR,
    GENERAL_OEM_ERROR,
    GENERAL_PLUGIN_ERROR,
    INIT_DATA_INVALID,
    KEY_NOT_LOADED,
    LICENSE_PARSE_ERROR,
    LICENSE_POLICY_ERROR,
    LICENSE_RELEASE_ERROR,
    LICENSE_REQUEST_REJECTED,
    LICENSE_RESTORE_ERROR,
    LICENSE_STATE_ERROR,
    MALFORMED_CERTIFICATE,
    MEDIA_FRAMEWORK_ERROR,
    MISSING_CERTIFICATE,
    PROVISIONING_CERTIFICATE_ERROR,
    PROVISIONING_CONFIGURATION_ERROR,
    PROVISIONING_PARSE_ERROR,
    PROVISIONING_REQUEST_REJECTED,
    RETRYABLE_PROVISIONING_ERROR,
    SECURE_STOP_RELEASE_ERROR,
    STORAGE_READ_FAILURE,
    STORAGE_WRITE_FAILURE,
}
```

这些 status 码映射到 `MediaDrm.ErrorCodes` 与 `MediaCodec.CryptoException` 的 Java 错误码，让应用能细粒度地理解失败原因。

### 42.3.7 AIDL 数据类型

DRM HAL 定义了众多 AIDL parcelable 类型。完整的类型层次如下：

```mermaid
classDiagram
    class DecryptArgs {
        +boolean secure
        +byte[] keyId
        +byte[] iv
        +Mode mode
        +Pattern pattern
        +SubSample[] subSamples
        +SharedBuffer source
        +long offset
        +DestinationBuffer destination
    }

    class SubSample {
        +int numBytesOfClearData
        +int numBytesOfEncryptedData
    }

    class Pattern {
        +int encryptBlocks
        +int skipBlocks
    }

    class SharedBuffer {
        +int bufferId
        +long offset
        +long size
        +NativeHandle handle
    }

    class KeyRequest {
        +byte[] request
        +KeyRequestType requestType
        +String defaultUrl
    }

    class KeyStatus {
        +byte[] keyId
        +KeyStatusType type
    }

    class ProvisionRequest {
        +byte[] request
        +String defaultUrl
    }

    class DrmMetricGroup {
        +List~DrmMetric~ metrics
    }

    class DrmMetric {
        +String name
        +List~DrmMetricNamedValue~ attributes
        +List~DrmMetricNamedValue~ values
    }

    class LogMessage {
        +long timeMs
        +LogPriority priority
        +String message
    }

    DecryptArgs --> SubSample
    DecryptArgs --> Pattern
    DecryptArgs --> SharedBuffer
    DrmMetricGroup --> DrmMetric
    DrmMetric --> DrmMetricNamedValue
```

### 42.3.8 VTS 测试

DRM HAL 附带完整的厂商测试套件（VTS），用接口契约验证 HAL 实现：

```
hardware/interfaces/drm/aidl/vts/
    drm_hal_common.cpp      Common test infrastructure (22 KB)
    drm_hal_test.cpp         Test cases (19 KB)
    drm_hal_test_main.cpp    Test entry point
    include/
        drm_hal_common.h    Test helper class definitions
```

VTS 测试会调用 `IDrmPlugin` 与 `ICryptoPlugin` 上的每一个方法，验证成功路径与错误路径的行为是否正确。

---

## 42.4 Widevine DRM

### 42.4.1 概览

Widevine 是 Google 的 DRM 技术，也是 Android 上部署最广的内容保护系统。它是闭源专有实现，但其架构通过它所实现的公开 DRM HAL 接口得到了充分披露。Widevine 由 UUID `edef8ba9-79d6-4ace-a3c8-27dcd51d21ed` 标识。

### 42.4.2 安全级别：L1、L2、L3

Widevine 定义了三个安全级别，对应到 HAL 的 SecurityLevel 枚举：

| Widevine 级别 | HAL SecurityLevel | 要求 |
|---------------|------------------|--------------|
| **L1** | `HW_SECURE_ALL` | 所有密码学操作与内容处理都在 TEE 中完成。密钥与解密内容绝不离开安全硬件。HD/4K/HDR 内容必需。 |
| **L2** | `HW_SECURE_CRYPTO` | 密码学操作在 TEE 中，但解码在软件中。密钥受硬件保护，但解密后的内容对 CPU 可见。实践中很少使用。 |
| **L3** | `SW_SECURE_CRYPTO` | 所有操作在软件中完成，配以白盒加密混淆。无硬件安全。多数许可证策略会将其限制在标清分辨率。 |

**Widevine L1——HW_SECURE_ALL 数据路径：**

```mermaid
graph TB
    L1_APP[Application] --> L1_FW[DRM Framework]
    L1_FW --> L1_WV[Widevine HAL]
    L1_WV --> L1_OEM[OEMCrypto in TEE]
    L1_OEM --> L1_DEC[Secure Video Decoder]
    L1_DEC --> L1_DISP[Secure Display Path]
    style L1_OEM fill:#4a9,stroke:#333,color:#fff
    style L1_DEC fill:#4a9,stroke:#333,color:#fff
    style L1_DISP fill:#4a9,stroke:#333,color:#fff
```

**Widevine L3——SW_SECURE_CRYPTO 数据路径：**

```mermaid
graph TB
    L3_APP[Application] --> L3_FW[DRM Framework]
    L3_FW --> L3_WV[Widevine HAL]
    L3_WV --> L3_SW["Software Crypto<br/>Whitebox AES"]
    L3_SW --> L3_DEC[Software Decoder]
    L3_DEC --> L3_DISP[Normal Display]
    style L3_SW fill:#d84,stroke:#333,color:#fff
    style L3_DEC fill:#d84,stroke:#333,color:#fff
```

### 42.4.3 TEE 集成

对于 L1 安全级别，Widevine 依赖 OEMCrypto——一个标准化接口。设备制造商在自家的可信执行环境（TEE）中实现它。TEE 通常是 ARM TrustZone 或类似的硬件隔离环境。

OEMCrypto 提供：

1. **设备密钥存储**：制造阶段写入硬件受保护存储的、每台设备唯一的 RSA 密钥对。
2. **会话密钥派生**：内容密钥由许可证服务器用设备公钥加密（包装），并在 TEE 内解包。
3. **内容解密**：媒体样本的 AES-CTR 或 AES-CBC 解密完全在安全世界中完成。
4. **输出保护强制执行**：TEE 在允许解密内容渲染之前，会校验显示输出上的 HDCP 级别。
5. **安全缓冲管理**：解密后的视频帧被写入正常世界 CPU 无法读取的安全内存区域。

```mermaid
graph LR
    subgraph "Normal World (Android)"
        APP[App] --> FW[DRM Framework]
        FW --> WV[Widevine Plugin]
    end

    subgraph "Secure World (TEE)"
        OEM[OEMCrypto API]
        KS["Key Storage<br/>RSA device key"]
        DEC[AES Decryptor]
        SB[Secure Buffers]
    end

    WV -->|SMC / TEE Client API| OEM
    OEM --> KS
    OEM --> DEC
    DEC --> SB

    subgraph "Hardware"
        SVD[Secure Video Decoder]
        HDCP[HDCP TX]
        DISP[Display]
    end

    SB --> SVD
    SVD --> HDCP
    HDCP --> DISP
```

### 42.4.4 预置流程

Widevine 设备的预置有两种方式：

1. **出厂预置**：设备制造期间，一枚唯一的设备证书被烧写进 TEE 的安全存储。该证书包含设备的 RSA 公钥以及来自 Widevine 的认证。这是 L1 设备的标准做法。

2. **在线预置**：若设备证书不存在（或对 L3 设备而言），设备可在运行时请求预置。`getProvisionRequest()` / `provideProvisionResponse()` 这两个 HAL 方法负责该流程。

### 42.4.5 许可证请求结构

Widevine 许可证请求包含：

- 设备证书（证明设备身份与安全级别）
- 内容标识（来自 PSSH 数据）
- 请求的密钥类型（流式或离线）
- HDCP 与输出保护能力
- 客户端信息（应用包名、设备型号）

许可证服务器依据内容所有者的策略评估这些信息，返回按适当范围限定、并为该设备加密的内容密钥。

### 42.4.6 HDCP 强制执行

Widevine 通过 `getHdcpLevels()` 方法强制执行 HDCP（高带宽数字内容保护）：

```
// Source: hardware/interfaces/drm/aidl/android/hardware/drm/IDrmPlugin.aidl
HdcpLevels getHdcpLevels();
```

它同时返回当前协商出的 HDCP 级别（取决于已连接的显示器）与设备支持的最高 HDCP 级别。内容策略可能要求特定 HDCP 级别（例如 4K 内容要求 HDCP 2.2）。DRM 插件必须执行这些要求；若不满足，就返回 `ERROR_DRM_INSUFFICIENT_OUTPUT_PROTECTION`。

### 42.4.7 与 MediaCodec 的集成

当 Widevine 报告需要安全解码器（`requiresSecureDecoderComponent()` 返回 `true`）时，`MediaCodec` 必须如此配置：

```java
codec.configure(format, surface, mediaCrypto,
        MediaCodec.CONFIGURE_FLAG_SECURE);
```

这会触发编解码器分配安全的输入与输出缓冲。加密输入由 `ICryptoPlugin::decrypt()` 调用解密，并置 `DecryptArgs.secure = true`。解密输出直接进入安全缓冲；只有硬件视频解码器与显示合成器能访问该缓冲。

---

## 42.5 ClearKey DRM 插件

### 42.5.1 目的与设计

ClearKey 是 AOSP 内置的参考 DRM 实现。它按 ISO/IEC 23001-7 通用加密（Common Encryption）标准工作，使用经 JSON Web Key（JWK）交付的未加密（“明文”）密钥。它有三重用途：

1. **测试**：开发者无需商用 DRM 服务器即可测试 DRM 播放流程。
2. **合规**：它验证 DRM 框架接口是否正确工作。
3. **参考**：它演示如何实现一个 DRM HAL 插件。

ClearKey 支持两个 UUID：

```cpp
// Source: frameworks/av/drm/mediadrm/plugins/clearkey/common/ClearKeyUUID.cpp
const std::array<uint8_t, 16> kCommonPsshBoxUUID{
    0x10,0x77,0xEF,0xEC,0xC0,0xB2,0x4D,0x02,
    0xAC,0xE3,0x3C,0x1E,0x52,0xE2,0xFB,0x4B
};

const std::array<uint8_t, 16> kClearKeyUUID{
    0xE2,0x71,0x9D,0x58,0xA9,0x85,0xB3,0xC9,
    0x78,0x1A,0xB0,0x30,0xAF,0x78,0xD3,0x0E
};
```

### 42.5.2 源码布局

```
frameworks/av/drm/mediadrm/plugins/clearkey/
    aidl/                      AIDL HAL implementation (current)
        Service.cpp            Binder service entry point
        DrmFactory.cpp         IDrmFactory implementation
        DrmPlugin.cpp          IDrmPlugin implementation (41 KB)
        CryptoPlugin.cpp       ICryptoPlugin implementation (10 KB)
        CreatePluginFactories.cpp
        include/
            DrmFactory.h
            DrmPlugin.h
            CryptoPlugin.h
            AidlUtils.h
            AidlClearKeryProperties.h
    common/                    Shared code between AIDL and legacy impls
        AesCtrDecryptor.cpp    AES-CTR decryption using OpenSSL
        ClearKeyUUID.cpp       UUID definitions
        InitDataParser.cpp     PSSH/CENC init data parsing
        JsonWebKey.cpp         JWK parsing
        Session.cpp            Session key management
        SessionLibrary.cpp     Session storage
        DeviceFiles.cpp        Offline license persistence
        MemoryFileSystem.cpp   In-memory file system for testing
        Base64.cpp             Base64 encoding/decoding
        Buffer.cpp             Buffer utilities
        Utils.cpp              Miscellaneous helpers
        include/clearkeydrm/
            AesCtrDecryptor.h
            ClearKeyTypes.h
            ClearKeyDrmProperties.h
            Session.h
            SessionLibrary.h
            ...
    default/                   Legacy HIDL implementation
        ...
```

### 42.5.3 服务入口点

ClearKey HAL 作为独立的 binder 服务运行：

```cpp
// Source: frameworks/av/drm/mediadrm/plugins/clearkey/aidl/Service.cpp
int main(int /*argc*/, char* argv[]) {
    InitLogging(argv, LogdLogger());
    ABinderProcess_setThreadPoolMaxThreadCount(8);

    std::shared_ptr<DrmFactory> drmFactory = createDrmFactory();
    const std::string drmInstance =
            std::string() + DrmFactory::descriptor + "/clearkey";
    binder_status_t status = AServiceManager_addService(
            drmFactory->asBinder().get(), drmInstance.c_str());
    CHECK(status == STATUS_OK);

    ABinderProcess_joinThreadPool();
    return EXIT_FAILURE;  // should not be reached
}
```

该服务在 binder 服务管理器中把自身注册为 `android.hardware.drm.IDrmFactory/clearkey`。

### 42.5.4 DrmFactory——插件创建

ClearKey 的 `DrmFactory` 校验 UUID 并创建插件实例：

```cpp
// Source: frameworks/av/drm/mediadrm/plugins/clearkey/aidl/DrmFactory.cpp
::ndk::ScopedAStatus DrmFactory::createDrmPlugin(
        const Uuid& in_uuid, const string& in_appPackageName,
        shared_ptr<IDrmPlugin>* _aidl_return) {
    if (!isClearKeyUUID(in_uuid.uuid.data())) {
        *_aidl_return = nullptr;
        return toNdkScopedAStatus(Status::BAD_VALUE);
    }
    shared_ptr<DrmPlugin> plugin =
            ::ndk::SharedRefBase::make<DrmPlugin>(
                    SessionLibrary::get());
    *_aidl_return = plugin;
    return toNdkScopedAStatus(Status::OK);
}
```

该工厂还会报告支持的 MIME 类型与安全级别：

```cpp
// Source: frameworks/av/drm/mediadrm/plugins/clearkey/aidl/DrmFactory.cpp
::ndk::ScopedAStatus DrmFactory::getSupportedCryptoSchemes(
        CryptoSchemes* _aidl_return) {
    CryptoSchemes schemes{};
    for (const auto& uuid : getSupportedCryptoSchemes()) {
        schemes.uuids.push_back({uuid});
    }
    for (auto mime : {kIsoBmffVideoMimeType, kIsoBmffAudioMimeType,
                      kCencInitDataFormat, kWebmVideoMimeType,
                      kWebmAudioMimeType, kWebmInitDataFormat}) {
        const auto minLevel = SecurityLevel::SW_SECURE_CRYPTO;
        const auto maxLevel = SecurityLevel::SW_SECURE_CRYPTO;
        schemes.mimeTypes.push_back({mime, minLevel, maxLevel});
    }
    *_aidl_return = schemes;
    return ndk::ScopedAStatus::ok();
}
```

注意 ClearKey 只支持 `SW_SECURE_CRYPTO`——它是纯软件插件，没有硬件安全支撑。

### 42.5.5 DrmPlugin——会话与密钥管理

ClearKey 的 `DrmPlugin`（`frameworks/av/drm/mediadrm/plugins/clearkey/aidl/DrmPlugin.cpp`）实现了完整的 `IDrmPlugin` 接口。要点如下。

**初始化：**

```cpp
// Source: frameworks/av/drm/mediadrm/plugins/clearkey/aidl/DrmPlugin.cpp
DrmPlugin::DrmPlugin(SessionLibrary* sessionLibrary)
    : mSessionLibrary(sessionLibrary),
      mOpenSessionOkCount(0),
      mCloseSessionOkCount(0),
      mCloseSessionNotOpenedCount(0),
      mNextSecureStopId(kSecureStopIdStart),
      mMockError(Status::OK) {
    mPlayPolicy.clear();
    initProperties();
    mSecureStops.clear();
    mReleaseKeysMap.clear();
    std::srand(std::time(nullptr));
}
```

**属性初始化：**

```cpp
// Source: frameworks/av/drm/mediadrm/plugins/clearkey/aidl/DrmPlugin.cpp
void DrmPlugin::initProperties() {
    mStringProperties.clear();
    mStringProperties[kVendorKey] = kAidlVendorValue;
    mStringProperties[kVersionKey] = kVersionValue;
    mStringProperties[kPluginDescriptionKey] = kAidlPluginDescriptionValue;
    mStringProperties[kAlgorithmsKey] = kAidlAlgorithmsValue;
    // ...
}
```

**安全停止管理：**

ClearKey 的安全停止只是一个测试环境，并非安全实现：

```cpp
// Source: frameworks/av/drm/mediadrm/plugins/clearkey/aidl/DrmPlugin.cpp
// The secure stop in ClearKey implementation is not installed securely.
// This function merely creates a test environment for testing secure
// stops APIs.
void DrmPlugin::installSecureStop(
        const std::vector<uint8_t>& sessionId) {
    Mutex::Autolock lock(mSecureStopLock);
    ClearkeySecureStop clearkeySecureStop;
    clearkeySecureStop.id = uint32ToVector(++mNextSecureStopId);
    clearkeySecureStop.data.assign(sessionId.begin(),
                                    sessionId.end());
    mSecureStops.insert(std::pair<std::vector<uint8_t>,
            ClearkeySecureStop>(clearkeySecureStop.id,
                                clearkeySecureStop));
}
```

### 42.5.6 CryptoPlugin——解密

ClearKey 的 `CryptoPlugin`（`frameworks/av/drm/mediadrm/plugins/clearkey/aidl/CryptoPlugin.cpp`）实现实际的解密。它支持两种模式：

1. **UNENCRYPTED**（`Mode::UNENCRYPTED`）：仅复制明文字节。
2. **AES_CTR**（`Mode::AES_CTR`）：使用 AES-128-CTR 模式解密。

解密方法展示了完整流程：

```cpp
// Source: frameworks/av/drm/mediadrm/plugins/clearkey/aidl/CryptoPlugin.cpp
::ndk::ScopedAStatus CryptoPlugin::decrypt(
        const DecryptArgs& in_args, int32_t* _aidl_return) {
    *_aidl_return = 0;

    // ClearKey does not support secure decryption
    if (in_args.secure) {
        return toNdkScopedAStatus(Status::ERROR_DRM_CANNOT_HANDLE,
                "secure decryption is not supported with ClearKey");
    }

    // Validate source and destination buffers...
    // (buffer bounds checking with overflow protection)

    if (in_args.mode == Mode::UNENCRYPTED) {
        // Copy clear data directly
        size_t offset = 0;
        for (size_t i = 0; i < in_args.subSamples.size(); ++i) {
            const SubSample& subSample = in_args.subSamples[i];
            if (subSample.numBytesOfClearData != 0) {
                memcpy(destPtr + offset, srcPtr + offset,
                       subSample.numBytesOfClearData);
                offset += subSample.numBytesOfClearData;
            }
        }
        *_aidl_return = static_cast<ssize_t>(offset);
        return toNdkScopedAStatus(Status::OK);

    } else if (in_args.mode == Mode::AES_CTR) {
        // Delegate to Session::decrypt which uses AesCtrDecryptor
        auto res = mSession->decrypt(
                in_args.keyId.data(), in_args.iv.data(),
                srcPtr, destPtr,
                clearDataLengths, encryptedDataLengths,
                &bytesDecrypted);
        // ...
    }
}
```

注意大量的溢出保护检查使用了 `__builtin_add_overflow`。每处检查都引用了一条具体的安全公告（例如 `android_errorWriteLog(0x534e4554, "176496160")`），说明这些边界检查是针对真实漏洞补上的。

### 42.5.7 AES-CTR 解密实现

实际的 AES-CTR 解密使用 OpenSSL：

```cpp
// Source: frameworks/av/drm/mediadrm/plugins/clearkey/common/AesCtrDecryptor.cpp
CdmResponseType AesCtrDecryptor::decrypt(
        const std::vector<uint8_t>& key, const Iv iv,
        const uint8_t* source, uint8_t* destination,
        const std::vector<int32_t>& clearDataLengths,
        const std::vector<int32_t>& encryptedDataLengths,
        size_t* bytesDecryptedOut) {

    if (key.size() != kBlockSize ||
        clearDataLengths.size() != encryptedDataLengths.size()) {
        return clearkeydrm::ERROR_DECRYPT;
    }

    uint32_t blockOffset = 0;
    uint8_t previousEncryptedCounter[kBlockSize];
    memset(previousEncryptedCounter, 0, kBlockSize);

    size_t offset = 0;
    AES_KEY opensslKey;
    AES_set_encrypt_key(key.data(), kBlockBitCount, &opensslKey);
    Iv opensslIv;
    memcpy(opensslIv, iv, sizeof(opensslIv));

    for (size_t i = 0; i < clearDataLengths.size(); ++i) {
        int32_t numBytesOfClearData = clearDataLengths[i];
        if (numBytesOfClearData > 0) {
            memcpy(destination + offset, source + offset,
                   numBytesOfClearData);
            offset += numBytesOfClearData;
        }
        int32_t numBytesOfEncryptedData = encryptedDataLengths[i];
        if (numBytesOfEncryptedData > 0) {
            AES_ctr128_encrypt(source + offset,
                               destination + offset,
                               numBytesOfEncryptedData,
                               &opensslKey, opensslIv,
                               previousEncryptedCounter,
                               &blockOffset);
            offset += numBytesOfEncryptedData;
        }
    }

    *bytesDecryptedOut = offset;
    return clearkeydrm::OK;
}
```

该实现按子样本顺序处理：明文数据用 memcpy 复制，加密数据用 OpenSSL 的 `AES_ctr128_encrypt()` 解密。IV 计数器状态在各子样本之间保持，以保证 CTR 模式的正确性。

### 42.5.8 JSON Web Key（JWK）处理

ClearKey 使用 JSON Web Key 交付密钥。密钥响应格式为：

```json
{
    "keys": [
        {
            "kty": "oct",
            "kid": "<base64url-encoded key ID>",
            "k": "<base64url-encoded key value>"
        }
    ],
    "type": "temporary"
}
```

`JsonWebKey` 解析器（`frameworks/av/drm/mediadrm/plugins/clearkey/common/JsonWebKey.cpp`）从这一 JSON 结构中提取密钥 ID 与密钥值。

对于离线许可证，`type` 字段为 `"persistent-license"`：

```cpp
// Source: frameworks/av/drm/mediadrm/plugins/clearkey/aidl/DrmPlugin.cpp
const std::string kOfflineLicense("\"type\":\"persistent-license\"");
```

### 42.5.9 会话架构

```mermaid
classDiagram
    class SessionLibrary {
        -map sessions
        +get() SessionLibrary
        +createSession() Session
        +findSession(id) Session
        +destroySession(session)
        +numOpenSessions() uint32_t
    }

    class Session {
        -sessionId: vector~uint8_t~
        -keyMap: KeyMap
        -mockError: CdmResponseType
        +decrypt(keyId, iv, src, dst, clear, enc, out) CdmResponseType
        +getKeyRequest(initData, mimeType) CdmResponseType
        +provideKeyResponse(response) CdmResponseType
    }

    class AesCtrDecryptor {
        +decrypt(key, iv, src, dst, clear, enc, out) CdmResponseType
    }

    SessionLibrary "1" --> "*" Session
    Session --> AesCtrDecryptor
```

`SessionLibrary` 是单例，管理所有已打开的会话。每个 `Session` 持有自己的密钥映射，并把解密委派给 `AesCtrDecryptor`。

### 42.5.10 构建 ClearKey

ClearKey 既可构建为常驻服务，也可构建为惰性（按需启动）服务：

```makefile
# Source: frameworks/av/drm/mediadrm/plugins/clearkey/service.mk
# Persistent service configuration
```

VINTF 清单声明如下：

```xml
<!-- Source: frameworks/av/drm/mediadrm/plugins/clearkey/aidl/
     android.hardware.drm-service.clearkey.xml -->
<manifest version="1.0" type="device">
    <hal format="aidl">
        <name>android.hardware.drm</name>
        <version>2</version>
        <fqname>IDrmFactory/clearkey</fqname>
    </hal>
</manifest>
```

`<version>2</version>` 元素把 ClearKey 声明为 V2 AIDL DRM HAL——即新增 `getKeyHandle()` 的那个版本，详见 42.8 节。

### 42.5.11 ClearKey 与生产 DRM 的对比

下表对比了 ClearKey 实现的内容与 Widevine 这类生产 DRM 系统必须提供的内容：

| 特性 | ClearKey | Widevine (L1) |
|---------|----------|---------------|
| 密钥传输 | 明文 JSON | 加密（设备密钥） |
| 密钥存储 | 内存 | TEE 安全存储 |
| 解密 | 正常世界中的 OpenSSL | TEE 中的 OEMCrypto |
| 安全缓冲 | 不支持 | 必需 |
| 安全级别 | 仅 SW_SECURE_CRYPTO | 最高 HW_SECURE_ALL |
| HDCP 强制执行 | 无（HDCP_NONE） | 完整（HDCP 2.2+） |
| 预置 | 不需要 | 出厂 + 在线 |
| 输出保护 | 无 | HDCP + 安全显示路径 |
| 离线许可证 | 模拟（内存文件系统） | 持久化安全存储 |
| 安全停止 | 测试实现 | 密码学签名 |

---

## 42.6 安全编解码路径

### 42.6.1 内容保护问题

受 DRM 保护的内容在为播放而解密之后，解密帧不得被应用代码或设备上运行的其它软件访问。如果某个应用能读取原始解码帧，它就能录制并再分发内容，DRM 的意义便荡然无存。安全编解码路径确保解密内容从解密到显示全程流经硬件受保护内存。

### 42.6.2 加密缓冲流

从加密媒体到屏幕的路径涉及若干次转换：

```mermaid
graph LR
    subgraph "Non-Secure Memory"
        A["Encrypted Media<br/>from network/storage"]
        B["MediaExtractor<br/>encrypted samples"]
    end

    subgraph "Shared Memory (Ashmem)"
        C["Encrypted Input Buffer<br/>SharedBuffer"]
    end

    subgraph "ICryptoPlugin"
        D{decrypt}
    end

    subgraph "Secure Memory"
        E["Decrypted Frame<br/>secure handle"]
    end

    subgraph "Secure Hardware"
        F[Secure Video Decoder]
        G[Protected Compositor]
        H[HDCP-Protected Output]
    end

    A --> B --> C --> D
    D -->|secure=true| E
    D -->|secure=false| C2[Non-secure output]
    E --> F --> G --> H
```

### 42.6.3 CryptoInfo 与 queueSecureInputBuffer

应用把加密缓冲排入 `MediaCodec` 时，会提供一个描述加密情况的 `CryptoInfo` 对象：

```java
MediaCodec.CryptoInfo cryptoInfo = new MediaCodec.CryptoInfo();
cryptoInfo.set(
    numSubSamples,        // number of subsamples
    numBytesOfClearData,  // int[] clear bytes per subsample
    numBytesOfEncryptedData, // int[] encrypted bytes per subsample
    keyId,                // 16-byte key identifier
    iv,                   // 16-byte initialization vector
    MediaCodec.CRYPTO_MODE_AES_CTR  // encryption mode
);

// For pattern encryption (CENC pattern mode)
cryptoInfo.setPattern(new MediaCodec.CryptoInfo.Pattern(
    encryptBlocks,  // number of 16-byte blocks to encrypt
    skipBlocks      // number of 16-byte blocks to skip
));

codec.queueSecureInputBuffer(bufferIndex, 0, cryptoInfo,
        presentationTimeUs, 0);
```

### 42.6.4 子样本结构

通用加密（CENC）标准定义了子样本结构：每个媒体样本由交替出现的明文区与加密区组成：

```mermaid
graph LR
    subgraph "Media Sample"
        S1["Clear: NAL header<br/>10 bytes"] --> S2["Encrypted: NAL body<br/>4086 bytes"]
        S2 --> S3["Clear: NAL header<br/>5 bytes"] --> S4["Encrypted: NAL body<br/>2043 bytes"]
    end
```

这在 HAL 中表示为 `SubSample` 数组：

```
// Source: hardware/interfaces/drm/aidl/android/hardware/drm/SubSample.aidl
parcelable SubSample {
    int numBytesOfClearData;
    int numBytesOfEncryptedData;
}
```

明文部分（通常是 H.264/H.265 的 NAL 单元头）保持不加密，使编解码器无需解密即可解析码流结构。

### 42.6.5 图案加密（CENC 图案模式）

现代 CENC 定义了图案模式：加密按固定大小的块交替进行：

```
// Source: hardware/interfaces/drm/aidl/android/hardware/drm/Pattern.aidl
parcelable Pattern {
    int encryptBlocks;  // number of 16-byte blocks to encrypt
    int skipBlocks;     // number of 16-byte blocks to leave clear
}
```

例如，`{1, 9}` 的图案表示加密一个 16 字节块、跳过九个，如此在整个加密区间重复。这降低了计算开销，同时在视觉上仍保护内容（因为即便只是部分加密视频帧，也足以让画面无法观看）。

### 42.6.6 共享缓冲架构

`ICryptoPlugin` 使用共享内存把加密数据从框架传给 HAL 插件解密：

```
// Source: hardware/interfaces/drm/aidl/android/hardware/drm/SharedBuffer.aidl
parcelable SharedBuffer {
    int bufferId;        // Identifies which shared memory region
    long offset;         // Offset within the region
    long size;           // Size of data
    NativeHandle handle; // Handle to the shared memory itself
}
```

`setSharedBufferBase()` 方法建立内存映射：

```
// From ICryptoPlugin.aidl
void setSharedBufferBase(in SharedBuffer base);
```

每个加密插件可以有多块共享缓冲，以 `bufferId` 区分。`CryptoHalAidl` 层会校验缓冲边界，防止越界访问：

```cpp
// Source: frameworks/av/drm/libmediadrm/CryptoHalAidl.cpp
status_t CryptoHalAidl::checkSharedBuffer(
        const SharedBufferHidl& buffer) {
    int32_t seqNum = static_cast<int32_t>(buffer.bufferId);
    if (mHeapSizes.indexOfKey(seqNum) < 0) {
        return UNKNOWN_ERROR;
    }
    size_t heapSize = mHeapSizes.valueFor(seqNum);
    if (heapSize < buffer.offset + buffer.size ||
        SIZE_MAX - buffer.offset < buffer.size) {
        android_errorWriteLog(0x534e4554, "76221123");
        return UNKNOWN_ERROR;
    }
    return OK;
}
```

### 42.6.7 目标缓冲类型

解密输出可以进入两类目的地：

```
// Source: hardware/interfaces/drm/aidl/android/hardware/drm/DestinationBuffer.aidl
union DestinationBuffer {
    SharedBuffer nonsecureMemory;   // CPU-accessible shared memory
    NativeHandle secureMemory;      // Opaque handle to secure buffer
}
```

对 L1（安全）播放，目的地是 `secureMemory` 句柄。CPU 无法读取该内存，只有安全视频解码器硬件能访问。对 L3（非安全）播放，目的地是 `nonsecureMemory`。

### 42.6.8 安全解码器选择

框架通过同时查询 DRM 插件与加密插件来决定是否使用安全解码器：

```mermaid
graph TB
    A[requiresSecureDecoder?] --> B{"IDrmPlugin::<br/>requiresSecureDecoder<br/>mime, level"}
    A --> C{"ICryptoPlugin::<br/>requiresSecureDecoderComponent<br/>mime"}

    B -->|true| D["Use secure codec<br/>CONFIGURE_FLAG_SECURE"]
    C -->|true| D
    B -->|false| E{Is secure preferred?}
    C -->|false| E
    E -->|yes| D
    E -->|no| F[Use normal codec]
```

### 42.6.9 分辨率通知

`ICryptoPlugin::notifyResolution()` 方法向插件通报当前显示分辨率：

```
void notifyResolution(in int width, in int height);
```

这使插件能执行基于分辨率的策略。例如，某许可证可能只允许 L1 安全级别下播放 4K，而把 L3 限制在 480p。插件可对照许可证策略检查分辨率，若违反策略就返回 `ERROR_DRM_INSUFFICIENT_OUTPUT_PROTECTION` 或 `ERROR_DRM_INSUFFICIENT_SECURITY`。

### 42.6.10 密钥句柄优化

V2 DRM HAL 为 `ICryptoPlugin` 新增了 `getKeyHandle()`，用于解密与解码合一的硬件路径：

```
// Source: hardware/interfaces/drm/aidl/android/hardware/drm/ICryptoPlugin.aidl
KeyHandleResult getKeyHandle(in byte[] keyId, in Mode mode);
```

它把一个密钥 ID 解析为不透明句柄（`KeyHandleResult.keyHandle`）。融合式安全解密-解码组件可以直接消费该句柄，而不必让每个样本都走一遍 `decrypt()`。该句柄可以引用 TEE 内已预载的密钥，从而避免反复进行“密钥 ID → 密钥材料”的解析。此方法仅自 AIDL HAL V2 起存在，因此框架对该调用做了版本门控。42.8 节将追踪这门控逻辑以及 Android 17 中的完整接线。

---

## 42.7 DRM 度量与日志

### 42.7.1 度量架构

Android 的 DRM 框架包含一套完整的度量系统，用于跟踪 DRM 操作的性能与可靠性，同时不暴露任何敏感内容或密钥材料。

```mermaid
graph TB
    subgraph "HAL Plugin"
        PM["Plugin Metrics<br/>IDrmPlugin::getMetrics"]
        PL["Plugin Logs<br/>IDrmPlugin::getLogMessages"]
    end

    subgraph "Framework - libmediadrm"
        DM["MediaDrmMetrics<br/>DrmMetrics.cpp"]
        DML2["DrmMetricsLogger<br/>DrmMetricsLogger.cpp"]
        DMC["DrmMetricsConsumer<br/>DrmMetricsConsumer.cpp"]
    end

    subgraph "System Services"
        MM[MediaMetrics Service]
        DS[dumpsys media.metrics]
    end

    subgraph "Application"
        APP[MediaDrm.getMetrics]
        PB[PersistableBundle]
    end

    PM -->|AIDL| DML2
    PL -->|AIDL| DML2
    DM --> DMC
    DML2 --> MM
    DM --> PB
    DMC --> PB
    PB --> APP
    MM --> DS
```

### 42.7.2 框架度量采集

`MediaDrmMetrics` 类（`frameworks/av/drm/libmediadrm/DrmMetrics.cpp`）在框架层用计数器与分布两类度量采集运行指标：

```cpp
// Source: frameworks/av/drm/libmediadrm/DrmMetrics.cpp
MediaDrmMetrics::MediaDrmMetrics()
    : mOpenSessionCounter("drm.mediadrm.open_session", "status"),
      mCloseSessionCounter("drm.mediadrm.close_session", "status"),
      mGetKeyRequestTimeUs("drm.mediadrm.get_key_request", "status"),
      mProvideKeyResponseTimeUs("drm.mediadrm.provide_key_response",
                                "status"),
      mGetProvisionRequestCounter(
              "drm.mediadrm.get_provision_request", "status"),
      mProvideProvisionResponseCounter(
              "drm.mediadrm.provide_provision_response", "status"),
      mKeyStatusChangeCounter("drm.mediadrm.key_status_change",
                              "key_status_type"),
      mEventCounter("drm.mediadrm.event", "event_type"),
      mGetDeviceUniqueIdCounter(
              "drm.mediadrm.get_device_unique_id", "status") {
}
```

所跟踪的度量包括：

| 度量 | 类型 | 说明 |
|--------|------|-------------|
| `open_session` | 计数器 | 会话打开尝试，按状态分 |
| `close_session` | 计数器 | 会话关闭尝试，按状态分 |
| `get_key_request` | 分布 | 密钥请求时延（微秒） |
| `provide_key_response` | 分布 | 密钥响应处理耗时 |
| `get_provision_request` | 计数器 | 预置请求数 |
| `provide_provision_response` | 计数器 | 预置响应数 |
| `key_status_change` | 计数器 | 密钥状态事件，按类型分 |
| `event` | 计数器 | DRM 事件，按类型分 |
| `get_device_unique_id` | 计数器 | 设备 ID 查询数 |

### 42.7.3 会话生命周期跟踪

框架会记录每个会话的开始与结束时间：

```cpp
// Source: frameworks/av/drm/libmediadrm/DrmMetrics.cpp
void MediaDrmMetrics::SetSessionStart(
        const Vector<uint8_t> &sessionId) {
    std::string sessionIdHex = ToHexString(sessionId);
    mSessionLifespans[sessionIdHex] =
        std::make_pair(GetCurrentTimeMs(), (int64_t)0);
}

void MediaDrmMetrics::SetSessionEnd(
        const Vector<uint8_t> &sessionId) {
    std::string sessionIdHex = ToHexString(sessionId);
    int64_t endTimeMs = GetCurrentTimeMs();
    if (mSessionLifespans.find(sessionIdHex) !=
            mSessionLifespans.end()) {
        mSessionLifespans[sessionIdHex] =
            std::make_pair(
                    mSessionLifespans[sessionIdHex].first,
                    endTimeMs);
    } else {
        mSessionLifespans[sessionIdHex] =
            std::make_pair((int64_t)0, endTimeMs);
    }
}
```

### 42.7.4 度量序列化

度量使用 Protocol Buffers 序列化，以便高效存储与传输：

```cpp
// Source: frameworks/av/drm/libmediadrm/DrmMetrics.cpp
status_t MediaDrmMetrics::GetSerializedMetrics(
        std::string *serializedMetrics) {
    DrmFrameworkMetrics metrics;

    mOpenSessionCounter.ExportValues(
        [&](const status_t status, const int64_t value) {
            auto *counter = metrics.add_open_session_counter();
            counter->set_count(value);
            counter->mutable_attributes()->set_error_code(status);
        });

    // ... export all metric types ...

    mGetKeyRequestTimeUs.ExportValues(
        [&](const status_t status, const EventStatistics &stats) {
            auto *metric = metrics.add_get_key_request_time_us();
            metric->set_min(stats.min);
            metric->set_max(stats.max);
            metric->set_mean(stats.mean);
            metric->set_operation_count(stats.count);
            metric->set_variance(
                    stats.sum_squared_deviation / stats.count);
            metric->mutable_attributes()->set_error_code(status);
        });

    for (const auto &sessionLifespan : mSessionLifespans) {
        auto *map = metrics.mutable_session_lifetimes();
        (*map)[sessionLifespan.first].set_start_time_ms(
            sessionLifespan.second.first);
        (*map)[sessionLifespan.first].set_end_time_ms(
            sessionLifespan.second.second);
    }

    return metrics.SerializeToString(serializedMetrics)
            ? OK : UNKNOWN_ERROR;
}
```

### 42.7.5 DrmMetricsLogger——MediaMetrics 集成

`DrmMetricsLogger` 类（`frameworks/av/drm/libmediadrm/DrmMetricsLogger.cpp`）是 `DrmHal` 外的一层包装。它拦截每一次 API 调用，采集耗时与结果码，然后上报给 `MediaMetrics` 服务：

```cpp
// Source: frameworks/av/drm/libmediadrm/DrmMetricsLogger.cpp
DrmMetricsLogger::DrmMetricsLogger(IDrmFrontend frontend)
    : mImpl(sp<DrmHal>::make()),
      mUuid(),
      mObjNonce(),
      mFrontend(frontend) {}
```

该记录器会把 DRM 错误码转换为枚举值，以便统计口径一致：

```cpp
// Source: frameworks/av/drm/libmediadrm/DrmMetricsLogger.cpp
int MediaErrorToEnum(status_t err) {
    switch (err) {
        STATUS_CASE(DRM_UNKNOWN);
        STATUS_CASE(DRM_NO_LICENSE);
        STATUS_CASE(DRM_LICENSE_EXPIRED);
        STATUS_CASE(DRM_RESOURCE_BUSY);
        STATUS_CASE(DRM_INSUFFICIENT_OUTPUT_PROTECTION);
        STATUS_CASE(DRM_SESSION_NOT_OPENED);
        // ... 30+ error code mappings ...
    }
    return ENUM_DRM_UNKNOWN;
}
```

### 42.7.6 DrmMetricsConsumer——PersistableBundle 导出

`DrmMetricsConsumer` 类（`frameworks/av/drm/libmediadrm/DrmMetricsConsumer.cpp`）把度量转换为 `PersistableBundle` 对象，经 `MediaDrm.getMetrics()` 返回给应用。

度量按成功与错误计数组织：

```cpp
// Source: frameworks/av/drm/libmediadrm/DrmMetricsConsumer.cpp
template <typename T>
void ExportCounterMetric(const CounterMetric<T> &counter,
                         PersistableBundle *metrics) {
    std::string success_count_name =
            counter.metric_name() + ".ok.count";
    std::string error_count_name =
            counter.metric_name() + ".error.count";
    counter.ExportValues(
        [&](const status_t status, const int64_t value) {
            if (status == OK) {
                metrics->putLong(
                        String16(success_count_name.c_str()),
                        value);
            } else {
                int64_t total_errors(0);
                metrics->getLong(
                        String16(error_count_name.c_str()),
                        &total_errors);
                metrics->putLong(
                        String16(error_count_name.c_str()),
                        total_errors + value);
            }
        });
}
```

### 42.7.7 插件级度量

HAL 通过 `getMetrics()` 方法提供插件专有的度量：

```
// Source: hardware/interfaces/drm/aidl/android/hardware/drm/DrmMetricGroup.aidl
parcelable DrmMetricGroup {
    List<DrmMetric> metrics;
}
```

每个 `DrmMetric` 由一个名称、一组属性（维度）与一组值（测量）构成：

```
// Source: hardware/interfaces/drm/aidl/android/hardware/drm/DrmMetric.aidl
parcelable DrmMetric {
    String name;
    List<DrmMetricNamedValue> attributes;
    List<DrmMetricNamedValue> values;
}
```

AIDL 文档给出了一个具体示例：

```
DrmMetricGroup {
    metrics[0] {
        name: "buf_copy"
        attributes[0] {
            name: "size"
            type: INT64_TYPE
            int64Value: 1024
        }
        values[0] {
            componentName: "operation_count"
            type: INT64_TYPE
            int64Value: 75
        }
        values[1] {
            component_name: "average_time_seconds"
            type: DOUBLE_TYPE
            doubleValue: 0.00000042
        }
    }
}
```

### 42.7.8 日志消息

`IDrmPlugin` 与 `ICryptoPlugin` 都支持 `getLogMessages()`：

```
// Source: hardware/interfaces/drm/aidl/android/hardware/drm/LogMessage.aidl
parcelable LogMessage {
    long timeMs;             // Timestamp in milliseconds since epoch
    LogPriority priority;    // ERROR, WARNING, INFO, DEBUG, VERBOSE
    String message;          // Human-readable message
}
```

这些日志消息旨在调试 DRM 问题而不泄露敏感信息。应用可通过 `MediaDrm.getLogMessages()` 访问它们，也可纳入错误报告。

### 42.7.9 面向应用的错误码

Java 的 `MediaDrm.ErrorCodes` 类为应用提供结构化的错误信息：

```java
// Source: frameworks/base/media/java/android/media/MediaDrm.java
public final static class ErrorCodes {
    public static final int ERROR_UNKNOWN = 0;
    public static final int ERROR_NO_KEY = 1;
    public static final int ERROR_KEY_EXPIRED = 2;
    public static final int ERROR_RESOURCE_BUSY = 3;
    public static final int ERROR_INSUFFICIENT_OUTPUT_PROTECTION = 4;
    public static final int ERROR_SESSION_NOT_OPENED = 5;
    public static final int ERROR_UNSUPPORTED_OPERATION = 6;
    public static final int ERROR_INSUFFICIENT_SECURITY = 7;
    public static final int ERROR_FRAME_TOO_LARGE = 8;
    public static final int ERROR_LOST_STATE = 9;
    public static final int ERROR_CERTIFICATE_MALFORMED = 10;
    public static final int ERROR_CERTIFICATE_MISSING = 11;
    public static final int ERROR_CRYPTO_LIBRARY = 12;
    public static final int ERROR_GENERIC_OEM = 13;
    public static final int ERROR_GENERIC_PLUGIN = 14;
    public static final int ERROR_INIT_DATA = 15;
    public static final int ERROR_KEY_NOT_LOADED = 16;
    public static final int ERROR_LICENSE_PARSE = 17;
    public static final int ERROR_LICENSE_POLICY = 18;
    // ... more error codes ...
}
```

每个错误码的 Javadoc 都包含恢复建议。`MediaDrmStateException` 还通过 `MediaDrmThrowable` 接口携带厂商专有错误码：

```java
// Source: frameworks/base/media/java/android/media/MediaDrm.java
public int getVendorError();    // Vendor-specific error code
public int getOemError();       // OEM-specific error code
public int getErrorContext();   // Additional error context
```

---

## 42.8 Android 17 中的 DRM HAL 变更

Android 17 没有改变上述 DRM 栈的形态。Java API、`libmediadrm`、AIDL+HIDL 双路由、ClearKey 与安全编解码路径都延续下来。变化的是 AIDL DRM HAL 契约：`android.hardware.drm` 接口现已冻结在版本 2，且 V2 相对 V1 的增量已一路贯通到框架。

本节说明 V2 究竟包含什么，也说明框架如何在运行时发现 V2，以及 V2 为何对安全解码路径至关重要。

### 42.8.1 AIDL DRM HAL 冻结在 V2

DRM HAL 接口包在其构建文件中声明版本。在 Android 17，接口已冻结，声明的最高版本为 2：

```
// Source: hardware/interfaces/drm/aidl/Android.bp
aidl_interface {
    name: "android.hardware.drm",
    stability: "vintf",
    frozen: true,
    versions_with_info: [
        { version: "1", /* ... */ },
        { version: "2", /* ... */ },
    ],
}
```

对应的 `aidl_api/android.hardware.drm/2/` 快照目录保存着已冻结的 V2 ABI。`frozen: true` 意味着 AIDL 工具链会拒绝任何未版本化的接口改动；新增方法或字段必须作为未来的 V3 落地。同一构建文件中的便捷默认值为 NDK 链接目标钉住 V2：

```
// Source: hardware/interfaces/drm/aidl/Android.bp
cc_defaults {
    name: "android.hardware.drm-media_drm-ndk-shared",
    shared_libs: ["android.hardware.drm-V2-ndk"],
}
```

### 42.8.2 V2 相对 V1 的增量

对比两个已冻结快照可见，V2 的增量很小且精准，仅限于 `ICryptoPlugin`：一个新方法，加上该方法返回的一个新 parcelable。

```
// Source: hardware/interfaces/drm/aidl/android/hardware/drm/ICryptoPlugin.aidl
KeyHandleResult getKeyHandle(in byte[] keyId, in Mode mode);
```

```
// Source: hardware/interfaces/drm/aidl/android/hardware/drm/KeyHandleResult.aidl
@VintfStability
parcelable KeyHandleResult {
    /**
     * An opaque handle to the selected key.
     */
    byte[] keyHandle;
}
```

`ICryptoPlugin` 的 V1 `aidl_api` 快照包含原有六个方法（`decrypt`、`getLogMessages`、`notifyResolution`、`requiresSecureDecoderComponent`、`setMediaDrmSession`、`setSharedBufferBase`）。V2 把 `getKeyHandle()` 作为第七个方法加入。`KeyHandleResult.aidl` 文件自版本 2 起才存在（其文件头带 2025 年版权声明）。V1 与 V2 之间没有任何其它接口（`IDrmFactory`、`IDrmPlugin`、`IDrmPluginListener`）发生变化。

`getKeyHandle()` 的用途是解密与解码合一的硬件路径。其契约注明，返回的句柄“由在同一步中完成解密与解码的组件使用”。若没有该方法，每个样本都要调用 `decrypt()`，再把解密后的字节交给另一个解码器。

有了它，融合式安全组件可以把密钥一次性解析为不透明句柄，然后驱动一次同时完成解密与解码的硬件操作。内容全程停留在受保护内存中。

### 42.8.3 框架中的运行时版本门控

由于 V2 是 V1 的严格超集，框架绝不能盲目对旧插件调用 `getKeyHandle()`。Android 17 把该方法加入完整的 `libmediadrm` 加密栈，并按协商出的接口版本做门控。统一的 `CryptoHal` 路由器在 AIDL 后端活跃时转发给它，否则转发给 HIDL：

```cpp
// Source: frameworks/av/drm/libmediadrm/CryptoHal.cpp
DrmStatus CryptoHal::getKeyHandle(const uint8_t key[16], CryptoPlugin::Mode mode,
                                  size_t sourceSize, size_t offset,
                                  const CryptoPlugin::SubSample* subSamples,
                                  size_t numSubSamples, Vector<uint8_t>& keyHandle) {
    if (mCryptoHalAidl->initCheck() == OK)
        return mCryptoHalAidl->getKeyHandle(key, mode, sourceSize, offset, subSamples,
                                            numSubSamples, keyHandle);
    return mCryptoHalHidl->getKeyHandle(key, mode, sourceSize, offset, subSamples,
                                        numSubSamples, keyHandle);
}
```

AIDL 后端会查询插件报告的接口版本。若插件只实现 V1，它就拒发该调用并返回 `ERROR_UNSUPPORTED`，从而避免一次插件无法满足的 Binder 调用：

```cpp
// Source: frameworks/av/drm/libmediadrm/CryptoHalAidl.cpp
int32_t version = 0;
if (mPlugin->getInterfaceVersion(&version).isOk() && version < 2) {
    return DrmStatus(ERROR_UNSUPPORTED, "getKeyHandle is not supported by the HAL");
}
```

在到达插件之前，`CryptoHalAidl::getKeyHandle()` 会执行与 `decrypt()` 相同的子样本与缓冲边界校验。它使用 `__builtin_add_overflow` 拒绝会导致整数溢出的子样本尺寸，并确认样本落在源缓冲之内。随后它把 16 字节密钥 ID 与加密模式转给插件，并把不透明句柄复制回来：

```cpp
// Source: frameworks/av/drm/libmediadrm/CryptoHalAidl.cpp
KeyHandleResult result;
::ndk::ScopedAStatus statusAidl = mPlugin->getKeyHandle(keyIdAidl, aMode, &result);
status_t err = statusAidlToDrmStatus(statusAidl);
if (err != OK) { /* log and return */ }
keyHandle = toVector(result.keyHandle);
```

### 42.8.4 调用方与 ClearKey 的行为

句柄路径由编解码器缓冲通道驱动。`CCodecBufferChannel` 仅在其 `mSendEncryptionKeyHandle` 标志置位时，才会在加密缓冲路径中调用 `mCrypto->getKeyHandle()`。这是一个静态的、配置期决定。该标志在 Codec2 组件声明 `C2StreamEncryptionKeyInfo::input` 参数、且 aconfig 开关 `com.android.media.codec.flags.decrypt_and_decode_in_hal` 启用时被设置。

若 `getKeyHandle()` 失败，缓冲通道会记录错误并把状态传播给调用方。它不会回落到逐样本的 `decrypt()` 流程：

```cpp
// Source: frameworks/av/media/codec2/sfplugin/CCodecBufferChannel.cpp
if (mSendEncryptionKeyHandle) {
    // ...
    const DrmStatus drmStatus = mCrypto->getKeyHandle(key, mode, size, offset, subSamples,
                                                      numSubSamples, keyHandle);
    const status_t status = drmStatus;
    if (status != OK) {
        ALOGE(/* ... */);   // error is returned to the caller -- no decrypt() fallback
        return status;
    }
    // ... wrap keyHandle in a C2StreamEncryptionKeyInfo::input param for the component
}
```

```mermaid
sequenceDiagram
    participant CC as CCodecBufferChannel
    participant CH as CryptoHal
    participant CHA as CryptoHalAidl
    participant CP as ICryptoPlugin V2 (HAL)

    CC->>CH: getKeyHandle(key, mode, size, ...)
    CH->>CHA: getKeyHandle (AIDL backend active)
    CHA->>CP: getInterfaceVersion()
    alt version is less than 2
        CHA-->>CC: ERROR_UNSUPPORTED (error propagated to caller)
    else version is 2 or higher
        CHA->>CP: getKeyHandle(keyId, mode)
        CP-->>CHA: KeyHandleResult{keyHandle}
        CHA-->>CC: opaque key handle
    end
```

AOSP 的参考插件 ClearKey 确实实现了 V2 方法。但它是纯软件插件，没有融合式安全解码-解密单元，因此只是拒绝：

```cpp
// Source: frameworks/av/drm/mediadrm/plugins/clearkey/aidl/CryptoPlugin.cpp
::ndk::ScopedAStatus CryptoPlugin::getKeyHandle(const std::vector<uint8_t>& in_keyId,
        Mode in_mode, KeyHandleResult* _aidl_return) {
    // Clearkey plugin does not have key handle
    return toNdkScopedAStatus(Status::ERROR_DRM_CANNOT_HANDLE);
}
```

实践中，像 ClearKey 这样的方案根本不会经编解码器路径走到这个桩实现。密钥句柄路线是在最前面就依据编解码器组件声明的参数（`mSendEncryptionKeyHandle`）选定的。只支持 L3 的方案所用的软件解码器不会声明 `C2StreamEncryptionKeyInfo::input`，于是缓冲通道一开始就走逐样本的 `decrypt()` 路径。

如果*确实*进入了密钥句柄路径而 `getKeyHandle()` 失败，缓冲通道会把错误返回给调用方，而不会静默地改用 `decrypt()` 重试。ClearKey 的 `ERROR_DRM_CANNOT_HANDLE` 就会造成这种失败。密钥句柄快速路径是给融合式硬件解密-解码栈（Widevine L1 级硬件）的可选项，并非对每个插件的新要求。

---

## 42.9 动手试试：DRM 实验练习

### 42.9.1 练习 1：查询支持的 DRM 方案

写一个简单的 Android 应用，查询设备上有哪些 DRM 方案可用：

```java
import android.media.MediaDrm;
import java.util.List;
import java.util.UUID;

public class DrmSchemeQuery {
    // Well-known DRM UUIDs
    private static final UUID WIDEVINE_UUID =
            new UUID(0xEDEF8BA979D64ACEL, 0xA3C827DCD51D21EDL);
    private static final UUID CLEARKEY_UUID =
            new UUID(0xE2719D58A985B3C9L, 0x781AB030AF78D30EL);
    private static final UUID COMMON_PSSH_UUID =
            new UUID(0x1077EFECC0B24D02L, 0xACE33C1E52E2FB4BL);

    public void querySchemes() {
        // Method 1: Check specific UUIDs
        System.out.println("Widevine supported: " +
                MediaDrm.isCryptoSchemeSupported(WIDEVINE_UUID));
        System.out.println("ClearKey supported: " +
                MediaDrm.isCryptoSchemeSupported(CLEARKEY_UUID));

        // Check with MIME type and security level
        System.out.println("Widevine MP4 L1: " +
                MediaDrm.isCryptoSchemeSupported(WIDEVINE_UUID,
                        "video/mp4",
                        MediaDrm.SECURITY_LEVEL_HW_SECURE_ALL));
        System.out.println("Widevine MP4 L3: " +
                MediaDrm.isCryptoSchemeSupported(WIDEVINE_UUID,
                        "video/mp4",
                        MediaDrm.SECURITY_LEVEL_SW_SECURE_CRYPTO));

        // Method 2: Enumerate all supported schemes
        List<UUID> schemes = MediaDrm.getSupportedCryptoSchemes();
        for (UUID uuid : schemes) {
            System.out.println("Supported scheme: " + uuid);
        }
    }
}
```

**观察要点：**

- 多数 Android 设备会把 Widevine 与 ClearKey 报告为支持。
- 安全级别检查能揭示设备是否具备 L1（硬件 TEE）支持。
- `getSupportedCryptoSchemes()` 返回所有已注册 HAL 工厂的 UUID。

### 42.9.2 练习 2：用 ExoPlayer 播放 ClearKey 内容

用 ExoPlayer（现属 AndroidX Media3）播放 ClearKey 加密的 DASH 内容：

```java
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.drm.DefaultDrmSessionManager;
import androidx.media3.exoplayer.drm.LocalMediaDrmCallback;
import androidx.media3.common.MediaItem;
import androidx.media3.common.C;

public class ClearKeyPlayback {

    // ClearKey license in JWK format (base64url-encoded)
    private static final String CLEARKEY_LICENSE =
        "{\"keys\":[" +
            "{\"kty\":\"oct\"," +
            "\"kid\":\"" + /* base64url key ID */ + "\"," +
            "\"k\":\"" + /* base64url key value */ + "\"}" +
        "],\"type\":\"temporary\"}";

    public void setupPlayer(Context context, SurfaceView surfaceView) {
        // Create DRM session manager for ClearKey
        DefaultDrmSessionManager drmSessionManager =
                new DefaultDrmSessionManager.Builder()
                        .setUuidAndExoMediaDrmProvider(
                                C.CLEARKEY_UUID,
                                FrameworkMediaDrm.DEFAULT_PROVIDER)
                        .build(new LocalMediaDrmCallback(
                                CLEARKEY_LICENSE.getBytes()));

        // Create player with DRM
        ExoPlayer player = new ExoPlayer.Builder(context)
                .build();
        player.setVideoSurfaceView(surfaceView);

        // Set DRM-protected media
        MediaItem mediaItem = new MediaItem.Builder()
                .setUri("https://example.com/content.mpd")
                .setDrmConfiguration(
                        new MediaItem.DrmConfiguration.Builder(
                                C.CLEARKEY_UUID)
                        .build())
                .build();

        player.setMediaItem(mediaItem);
        player.prepare();
        player.play();
    }
}
```

### 42.9.3 练习 3：查看 DRM 属性

打开一个 DRM 会话并查询插件属性：

```java
import android.media.MediaDrm;
import android.os.PersistableBundle;

public class DrmPropertyInspector {

    private static final UUID WIDEVINE_UUID =
            new UUID(0xEDEF8BA979D64ACEL, 0xA3C827DCD51D21EDL);

    public void inspectProperties() throws Exception {
        MediaDrm drm = new MediaDrm(WIDEVINE_UUID);

        // Query standard properties
        String vendor = drm.getPropertyString("vendor");
        String version = drm.getPropertyString("version");
        String description = drm.getPropertyString("description");
        byte[] deviceId = drm.getPropertyByteArray("deviceUniqueId");

        System.out.println("Vendor: " + vendor);
        System.out.println("Version: " + version);
        System.out.println("Description: " + description);
        System.out.println("Device ID length: " + deviceId.length);

        // Open session and check security level
        byte[] sessionId = drm.openSession();
        int securityLevel = drm.getSecurityLevel(sessionId);
        System.out.println("Security level: " + securityLevel);

        // Get metrics
        PersistableBundle metrics = drm.getMetrics();
        // Inspect metric keys
        for (String key : metrics.keySet()) {
            System.out.println("Metric: " + key + " = " +
                    metrics.get(key));
        }

        // Get log messages (for debugging)
        java.util.List<MediaDrm.LogMessage> logs =
                drm.getLogMessages();
        for (MediaDrm.LogMessage log : logs) {
            System.out.println("Log [" + log.getTimestampMillis() +
                    "] " + log.getMessage());
        }

        drm.closeSession(sessionId);
        drm.close();
    }
}
```

### 42.9.4 练习 4：用 dumpsys 查看 HAL 接口

用 `adb shell` 查看运行中的 DRM HAL：

```bash
# List registered DRM HAL services
adb shell service list | grep drm

# Check ClearKey service status
adb shell dumpsys android.hardware.drm.IDrmFactory/clearkey

# View media DRM metrics
adb shell dumpsys media.metrics | grep -i drm

# List VINTF HAL declarations
adb shell lshal | grep drm

# Inspect the legacy DRM manager service (registered as drm.drmManager)
adb shell dumpsys drm.drmManager
```

### 42.9.5 练习 5：跟踪 DRM 操作

用 `atrace` 与 `systrace` 观察播放期间的 DRM 操作：

```bash
# Enable trace tags that cover DRM HAL activity (there is no dedicated
# "drm" atrace category -- DRM shows up under hal/binder_driver/video)
adb shell atrace --async_start video hal binder_driver

# Play DRM content, then stop tracing
adb shell atrace --async_stop > /tmp/drm_trace.txt

# View DRM-specific logs
adb logcat -s DrmHal:V DrmHalAidl:V CryptoHalAidl:V \
    clearkey-DrmPlugin:V clearkey-CryptoPlugin:V \
    DrmSessionManager:V DrmMetricsLogger:V
```

### 42.9.6 练习 6：从源码构建 ClearKey

从 AOSP 源码构建 ClearKey HAL 插件：

```bash
# Navigate to the AOSP source tree
cd $AOSP_ROOT

# Build just the ClearKey plugin
m android.hardware.drm-service.clearkey

# The output binary will be at:
# out/target/product/*/vendor/bin/hw/
#     android.hardware.drm-service.clearkey

# Build the AIDL DRM VTS tests
m VtsAidlHalDrmTargetTest

# Push and run the VTS tests; restrict to the ClearKey instance with a
# gtest filter (the test enumerates all registered IDrmFactory instances)
adb push $ANDROID_PRODUCT_OUT/data/nativetest64/VtsAidlHalDrmTargetTest/VtsAidlHalDrmTargetTest \
    /data/local/tmp/VtsAidlHalDrmTargetTest
adb shell /data/local/tmp/VtsAidlHalDrmTargetTest --gtest_filter='*clearkey*'
```

### 42.9.7 练习 7：监控 DRM 会话生命周期

写一个基于监听器的监视程序，跟踪所有 DRM 事件：

```java
import android.media.MediaDrm;
import java.util.List;

public class DrmSessionMonitor {

    private static final UUID WIDEVINE_UUID =
            new UUID(0xEDEF8BA979D64ACEL, 0xA3C827DCD51D21EDL);

    public void monitorSession() throws Exception {
        MediaDrm drm = new MediaDrm(WIDEVINE_UUID);

        // Register all listeners
        drm.setOnExpirationUpdateListener((md, sessionId, expiryTime) -> {
            System.out.println("Expiration update: session=" +
                    bytesToHex(sessionId) +
                    " expiry=" + expiryTime);
        }, null);

        drm.setOnKeyStatusChangeListener(
                (md, sessionId, keyInfo, hasNewUsableKey) -> {
            System.out.println("Key status change: session=" +
                    bytesToHex(sessionId) +
                    " hasUsableKey=" + hasNewUsableKey);
            for (MediaDrm.KeyStatus ks : keyInfo) {
                System.out.println("  Key " +
                        bytesToHex(ks.getKeyId()) +
                        " status=" + ks.getStatusCode());
            }
        }, null);

        drm.setOnSessionLostStateListener(
                (md, sessionId) -> {
            System.out.println("Session lost state: " +
                    bytesToHex(sessionId));
        }, null);

        drm.setOnEventListener((md, sessionId, event, extra, data) -> {
            System.out.println("DRM event: type=" + event +
                    " extra=" + extra);
        });

        // Open session and perform key exchange...
        byte[] sessionId = drm.openSession();
        // ... use session for playback ...

        drm.closeSession(sessionId);
        drm.close();
    }

    private String bytesToHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }
}
```

### 42.9.8 练习 8：查看 ClearKey 源码

在源码中追踪完整的 ClearKey 密钥请求/响应流程：

```bash
# Step 1: Start at the factory
# File: frameworks/av/drm/mediadrm/plugins/clearkey/aidl/DrmFactory.cpp
# DrmFactory::createDrmPlugin() validates UUID, creates DrmPlugin

# Step 2: Session creation
# File: frameworks/av/drm/mediadrm/plugins/clearkey/common/SessionLibrary.cpp
# SessionLibrary::createSession() generates session ID

# Step 3: Key request generation
# File: frameworks/av/drm/mediadrm/plugins/clearkey/aidl/DrmPlugin.cpp
# DrmPlugin::getKeyRequest() parses PSSH init data

# Step 4: Init data parsing
# File: frameworks/av/drm/mediadrm/plugins/clearkey/common/InitDataParser.cpp
# InitDataParser::parse() extracts key IDs from PSSH/CENC

# Step 5: Key response processing
# DrmPlugin::provideKeyResponse() parses JWK

# Step 6: JWK parsing
# File: frameworks/av/drm/mediadrm/plugins/clearkey/common/JsonWebKey.cpp
# JsonWebKey::extractKeysFromJsonWebKeySet() decodes keys

# Step 7: Decryption
# File: frameworks/av/drm/mediadrm/plugins/clearkey/aidl/CryptoPlugin.cpp
# CryptoPlugin::decrypt() delegates to Session::decrypt()

# Step 8: AES-CTR decryption
# File: frameworks/av/drm/mediadrm/plugins/clearkey/common/AesCtrDecryptor.cpp
# AesCtrDecryptor::decrypt() uses OpenSSL AES_ctr128_encrypt
```

---

## 本章小结

Android 的 DRM 架构是一个多层系统，旨在同时满足内容保护、设备多样性与应用简洁性这些相互冲突的诉求。

**关键架构决策：**

1. **基于 UUID 的抽象**：应用通过与方案无关的 API 与 DRM 交互。UUID 机制让多种 DRM 系统可以共存于同一台设备。

2. **HAL 隔离**：密码学实现运行在独立进程（且可能在 TEE 内），与应用代码隔离。AIDL HAL 在框架与厂商插件之间提供稳定、带版本的契约。

3. **双后端兼容**：`DrmHal` / `CryptoHal` 路由层同时支持 AIDL 与 HIDL 后端，使得从 HIDL 向 AIDL 的渐进迁移不会破坏既有厂商实现。

4. **安全缓冲流水线**：对 L1 安全级别，解密内容绝不触碰 CPU 可访问内存。从解密经解码到显示的整条路径都在硬件受保护内存中运行。

5. **完整的度量体系**：三层度量系统（框架计数器、插件度量、日志消息）在不牺牲内容安全的前提下提供诊断可见性。

**供进一步探索的关键源码文件：**

| 组件 | 路径 |
|-----------|------|
| MediaDrm Java API | `frameworks/base/media/java/android/media/MediaDrm.java` |
| MediaCrypto Java API | `frameworks/base/media/java/android/media/MediaCrypto.java` |
| DrmHal (unified) | `frameworks/av/drm/libmediadrm/DrmHal.cpp` |
| DrmHalAidl | `frameworks/av/drm/libmediadrm/DrmHalAidl.cpp` |
| CryptoHalAidl | `frameworks/av/drm/libmediadrm/CryptoHalAidl.cpp` |
| DrmSessionManager | `frameworks/av/drm/libmediadrm/DrmSessionManager.cpp` |
| DrmMetrics | `frameworks/av/drm/libmediadrm/DrmMetrics.cpp` |
| DrmMetricsLogger | `frameworks/av/drm/libmediadrm/DrmMetricsLogger.cpp` |
| IDrmFactory AIDL | `hardware/interfaces/drm/aidl/android/hardware/drm/IDrmFactory.aidl` |
| IDrmPlugin AIDL | `hardware/interfaces/drm/aidl/android/hardware/drm/IDrmPlugin.aidl` |
| ICryptoPlugin AIDL | `hardware/interfaces/drm/aidl/android/hardware/drm/ICryptoPlugin.aidl` |
| SecurityLevel AIDL | `hardware/interfaces/drm/aidl/android/hardware/drm/SecurityLevel.aidl` |
| Status AIDL | `hardware/interfaces/drm/aidl/android/hardware/drm/Status.aidl` |
| ClearKey Factory | `frameworks/av/drm/mediadrm/plugins/clearkey/aidl/DrmFactory.cpp` |
| ClearKey DrmPlugin | `frameworks/av/drm/mediadrm/plugins/clearkey/aidl/DrmPlugin.cpp` |
| ClearKey CryptoPlugin | `frameworks/av/drm/mediadrm/plugins/clearkey/aidl/CryptoPlugin.cpp` |
| ClearKey AES-CTR | `frameworks/av/drm/mediadrm/plugins/clearkey/common/AesCtrDecryptor.cpp` |
| ClearKey UUID | `frameworks/av/drm/mediadrm/plugins/clearkey/common/ClearKeyUUID.cpp` |
| VTS Tests | `hardware/interfaces/drm/aidl/vts/drm_hal_test.cpp` |
