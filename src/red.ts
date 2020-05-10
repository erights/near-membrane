/**
 * This file implements a serializable factory function that is invoked once per sandbox
 * and it is used to create red proxies where all identities are defined inside
 * the sandbox, this guarantees that any error when interacting with those proxies, has
 * the proper identity to avoid leaking references from the blue realm into the sandbox
 * this is especially important for out of memory errors.
 *
 * IMPORTANT:
 *  - This file can't import anything from the package, only types since it is going to
 *    be serialized, and therefore it will loose the reference.
 */
import {
    RedProxyTarget,
    RedValue,
    RedObject,
    RedShadowTarget,
    RedFunction,
    RedArray,
    RedProxy,
    BlueConstructor,
    BlueFunction,
    BlueValue,
    BlueArray,
    TargetMeta,
    MembraneBroker,
} from './types';

/**
 * Blink (Chrome) imposes certain restrictions for detached iframes, specifically,
 * any callback (or potentially a constructor) invoked from a detached iframe
 * will throw an error as detailed here:
 *
 *  - https://bugs.chromium.org/p/chromium/issues/detail?id=1042435#c4
 *
 * This restriction seems some-how arbitrary at this point because you can easily
 * bypass it by preserving the following two invariants:
 *
 * 1. a call to a dom DOM API must be done from the main window.
 * 2. any callback passed into a DOM API must be wrapped with a
 *    proxy from the main realm.
 *
 * For that, the environment must provide two hooks that when called
 * they will delegate to Reflect.apply/Reflect.construct on the blue
 * realm, you cannot call Reflect.* from inside the sandbox or the blue
 * realm directly, it must be a wrapping function.
 */
export interface MarshalHooks {
    apply(target: BlueFunction, thisArgument: BlueValue, argumentsList: ArrayLike<BlueValue>): BlueValue;
    construct(target: BlueConstructor, argumentsList: ArrayLike<BlueValue>, newTarget?: any): BlueValue;
}

export const serializedRedEnvSourceText = (function redEnvFactory(blueEnv: MembraneBroker, hooks: MarshalHooks) {
    'use strict';

    const LockerLiveValueMarkerSymbol = Symbol.for('@@lockerLiveValue');
    const { blueMap, distortionMap } = blueEnv;
    const { apply: blueApplyHook, construct: blueConstructHook } = hooks;

    const {
        apply,
        construct,
        isExtensible,
        getOwnPropertyDescriptor,
        setPrototypeOf,
        getPrototypeOf,
        preventExtensions,
        deleteProperty,
        ownKeys,
        defineProperty,
        get: ReflectGet,
        set: ReflectSet,
    } = Reflect;
    const {
        assign,
        create,
        defineProperty: ObjectDefineProperty,
        getOwnPropertyDescriptors,
        freeze,
        seal,
        isSealed,
        isFrozen,
        hasOwnProperty,
    } = Object;
    const ProxyRevocable = Proxy.revocable;
    const ProxyCreate = unconstruct(Proxy);
    const { isArray: isArrayOrNotOrThrowForRevoked } = Array;
    const noop = () => undefined;
    const map = unapply(Array.prototype.map);
    const WeakMapGet = unapply(WeakMap.prototype.get);
    const WeakMapHas = unapply(WeakMap.prototype.has);
    const ErrorCreate = unconstruct(Error);

    function unapply(func: Function): Function {
        return (thisArg: any, ...args: any[]) => apply(func, thisArg, args);
    }

    function unconstruct(func: Function): Function {
        return (...args: any[]) => construct(func, args);
    }

    function isUndefined(obj: any): obj is undefined {
        return obj === undefined;
    }

    function isNull(obj: any): obj is null {
        return obj === null;
    }

    function isFunction(obj: any): obj is Function {
        return typeof obj === 'function';
    }

    function isNullOrUndefined(obj: any): obj is (null | undefined) {
        return isNull(obj) || isUndefined(obj);
    }

    function getRedValue(blue: BlueValue): RedValue {
        if (isNullOrUndefined(blue)) {
            return blue as RedValue;
        }
        // NOTE: internationally checking for typeof 'undefined' for the case of
        // `typeof document.all === 'undefined'`, which is an exotic object with
        // a bizarre behavior described here:
        // * https://tc39.es/ecma262/#sec-IsHTMLDDA-internal-slot
        // This check covers that case, but doesn't affect other undefined values
        // because those are covered by the previous condition anyways.
        if (typeof blue === 'undefined') {
            return undefined;
        }
        if (typeof blue === 'function') {
            return getRedFunction(blue);
        }
        let isBlueArray = false;
        try {
            isBlueArray = isArrayOrNotOrThrowForRevoked(blue);
        } catch {
            // blue was revoked - but we call createRedProxy to support distortions
            return createRedProxy(blue);
        }
        if (isBlueArray) {
            return getRedArray(blue);
        } else if (typeof blue === 'object') {
            const red: RedValue | undefined = WeakMapGet(blueMap, blue);
            if (isUndefined(red)) {
                return createRedProxy(blue);
            }
            return red;
        } else {
            return blue as RedValue;
        }
    }

    function getRedArray(blueArray: BlueArray): RedArray {
        const b: RedValue[] = map(blueArray, (blue: BlueValue) => getRedValue(blue));
        // identity of the new array correspond to the inner realm
        return [...b];
    }

    function getRedFunction(blueFn: BlueFunction): RedFunction {
        const redFn: RedFunction | undefined = WeakMapGet(blueMap, blueFn);
        if (isUndefined(redFn)) {
            return createRedProxy(blueFn) as RedFunction;
        }
        return redFn;
    }

    function getDistortedValue(target: RedProxyTarget): RedProxyTarget {
        if (!WeakMapHas(distortionMap, target)) {
            return target;
        }
        // if a distortion entry is found, it must be a valid proxy target
        const distortedTarget = WeakMapGet(distortionMap, target) as RedProxyTarget;
        return distortedTarget;
    }

    function renameFunction(blueProvider: (...args: any[]) => any, receiver: (...args: any[]) => any) {
        try {
            // a revoked proxy will break the membrane when reading the function name
            const nameDescriptor = getOwnPropertyDescriptor(blueProvider, 'name')!;
            defineProperty(receiver, 'name', nameDescriptor);
        } catch {
            // intentionally swallowing the error because this method is just extracting the function
            // in a way that it should always succeed except for the cases in which the provider is a proxy
            // that is either revoked or has some logic to prevent reading the name property descriptor.
        }
    }    

    function installDescriptorIntoShadowTarget(shadowTarget: RedProxyTarget, key: PropertyKey, originalDescriptor: PropertyDescriptor) {
        const shadowTargetDescriptor = getOwnPropertyDescriptor(shadowTarget, key);
        if (!isUndefined(shadowTargetDescriptor)) {
            if (hasOwnProperty.call(shadowTargetDescriptor, 'configurable') &&
                    shadowTargetDescriptor.configurable === true) {
                defineProperty(shadowTarget, key, originalDescriptor);
            } else if (hasOwnProperty.call(shadowTargetDescriptor, 'writable') &&
                    shadowTargetDescriptor.writable === true) {
                // just in case
                shadowTarget[key] = originalDescriptor.value;
            } else {
                // ignoring... since it is non configurable and non-writable
                // usually, arguments, callee, etc.
            }
        } else {
            defineProperty(shadowTarget, key, originalDescriptor);
        }
    }

    function getRedDescriptor(blueDescriptor: PropertyDescriptor): PropertyDescriptor {
        const redDescriptor = assign(create(null), blueDescriptor);
        const { value: blueValue, get: blueGet, set: blueSet } = redDescriptor;
        if ('writable' in redDescriptor) {
            // we are dealing with a value descriptor
            redDescriptor.value = isFunction(blueValue) ?
                // we are dealing with a method (optimization)
                getRedFunction(blueValue) : getRedValue(blueValue);
        } else {
            // we are dealing with accessors
            if (isFunction(blueSet)) {
                redDescriptor.set = getRedFunction(blueSet);
            }
            if (isFunction(blueGet)) {
                redDescriptor.get = getRedFunction(blueGet);
            }
        }
        return redDescriptor;
    }

    function copyRedOwnDescriptors(shadowTarget: RedShadowTarget, blueDescriptors: PropertyDescriptorMap) {
        for (const key in blueDescriptors) {
            // avoid poisoning by checking own properties from descriptors
            if (hasOwnProperty.call(blueDescriptors, key)) {
                const originalDescriptor = getRedDescriptor(blueDescriptors[key]);
                installDescriptorIntoShadowTarget(shadowTarget, key, originalDescriptor);
            }
        }
    }

    function copyBlueDescriptorIntoShadowTarget(shadowTarget: RedShadowTarget, originalTarget: RedProxyTarget, key: PropertyKey) {
        // Note: a property might get defined multiple times in the shadowTarget
        //       but it will always be compatible with the previous descriptor
        //       to preserve the object invariants, which makes these lines safe.
        const normalizedBlueDescriptor = getOwnPropertyDescriptor(originalTarget, key);
        if (!isUndefined(normalizedBlueDescriptor)) {
            const redDesc = getRedDescriptor(normalizedBlueDescriptor);
            defineProperty(shadowTarget, key, redDesc);
        }
    }

    function lockShadowTarget(shadowTarget: RedShadowTarget, originalTarget: RedProxyTarget) {
        const targetKeys = ownKeys(originalTarget);
        for (let i = 0, len = targetKeys.length; i < len; i += 1) {
            copyBlueDescriptorIntoShadowTarget(shadowTarget, originalTarget, targetKeys[i]);
        }
        preventExtensions(shadowTarget);
    }

    function getTargetMeta(target: RedProxyTarget): TargetMeta {
        const meta: TargetMeta = create(null);
        try {
            // a revoked proxy will break the membrane when reading the meta
            meta.proto = getPrototypeOf(target);
            meta.descriptors = getOwnPropertyDescriptors(target);
            if (isFrozen(target)) {
                meta.isFrozen = meta.isSealed = meta.isExtensible = true;
            } else if (isSealed(target)) {
                meta.isSealed = meta.isExtensible = true;
            } else if (isExtensible(target)) {
                meta.isExtensible = true;
            }
            // if the target was revoked or become revoked during the extraction
            // of the metadata, we mark it as broken in the catch.
            isArrayOrNotOrThrowForRevoked(target);
        } catch (_ignored) {
            // intentionally swallowing the error because this method is just extracting the metadata
            // in a way that it should always succeed except for the cases in which the target is a proxy
            // that is either revoked or has some logic that is incompatible with the membrane, in which
            // case we will just create the proxy for the membrane but revoke it right after to prevent
            // any leakage.
            meta.proto = null;
            meta.descriptors = {};
            meta.isBroken = true;
        }
        return meta;
    }

    function getBluePartialDescriptor(redPartialDesc: PropertyDescriptor): PropertyDescriptor {
        const bluePartialDesc = assign(create(null), redPartialDesc);
        if ('value' in bluePartialDesc) {
            // we are dealing with a value descriptor
            bluePartialDesc.value = blueEnv.getBlueValue(bluePartialDesc.value);
        }
        if ('set' in bluePartialDesc) {
            // we are dealing with accessors
            bluePartialDesc.set = blueEnv.getBlueValue(bluePartialDesc.set);
        }
        if ('get' in bluePartialDesc) {
            bluePartialDesc.get = blueEnv.getBlueValue(bluePartialDesc.get);
        }
        return bluePartialDesc;
    }

    function redProxyApplyTrap(blueTarget: BlueFunction, redThisArg: RedValue, redArgArray: RedValue[]): RedValue {
        let blue;
        try {
            const blueThisArg = blueEnv.getBlueValue(redThisArg);
            const blueArgArray = blueEnv.getBlueValue(redArgArray);
            blue = blueApplyHook(blueTarget, blueThisArg, blueArgArray);
        } catch (e) {
            // This error occurred when the sandbox attempts to call a
            // function from the blue realm. By throwing a new red error,
            // we eliminates the stack information from the blue realm as a consequence.
            let redError;
            const { message, constructor } = e;
            try {
                // the error constructor must be a blue error since it occur when calling
                // a function from the blue realm.
                const redErrorConstructor = blueEnv.getRedRef(constructor);
                // the red constructor must be registered (done during construction of env)
                // otherwise we need to fallback to a regular error.
                redError = construct(redErrorConstructor as RedFunction, [message]);
            } catch {
                // in case the constructor inference fails
                redError = new Error(message);
            }
            throw redError;
        }
        return getRedValue(blue);
    }

    function redProxyConstructTrap(BlueCtor: BlueConstructor, redArgArray: RedValue[], redNewTarget: RedObject): RedObject {
        if (isUndefined(redNewTarget)) {
            throw TypeError();
        }
        let blue;
        try {
            const blueNewTarget = blueEnv.getBlueValue(redNewTarget);
            const blueArgArray = blueEnv.getBlueValue(redArgArray);
            blue = blueConstructHook(BlueCtor, blueArgArray, blueNewTarget);
        } catch (e) {
            // This error occurred when the sandbox attempts to new a
            // constructor from the blue realm. By throwing a new red error,
            // we eliminates the stack information from the blue realm as a consequence.
            let redError;
            const { message, constructor } = e;
            try {
                // the error constructor must be a blue error since it occur when calling
                // a function from the blue realm.
                const redErrorConstructor = blueEnv.getRedRef(constructor);
                // the red constructor must be registered (done during construction of env)
                // otherwise we need to fallback to a regular error.
                redError = construct(redErrorConstructor as RedFunction, [message]);
            } catch {
                // in case the constructor inference fails
                redError = new Error(message);
            }
            throw redError;
        }
        return getRedValue(blue);
    }

    /**
     * RedStaticProxyHandler class is used for any object or function coming from
     * the blue realm. It implements a proxy handler that takes a snapshot
     * of the object or function, and preserve them by preventing any mutation
     * or operation that can cause a side-effect on the original target.
     */
    class RedStaticProxyHandler implements ProxyHandler<RedProxyTarget> {
        // original target for the proxy
        private readonly target: RedProxyTarget;
        // metadata about the shape of the target
        private readonly meta: TargetMeta;
    
        constructor(blue: RedProxyTarget, meta: TargetMeta) {
            this.target = blue;
            this.meta = meta;
        }
        // initialization used to avoid the initialization cost
        // of an object graph, we want to do it when the
        // first interaction happens.
        private initialize(shadowTarget: RedShadowTarget) {
            const { meta } = this;
            const { proto: blueProto } = meta;
            // once the initialization is executed once... the rest is just noop 
            this.initialize = noop;
            // adjusting the proto chain of the shadowTarget (recursively)
            const redProto = getRedValue(blueProto);
            setPrototypeOf(shadowTarget, redProto);
            // defining own descriptors
            copyRedOwnDescriptors(shadowTarget, meta.descriptors);
            // preserving the semantics of the object
            if (meta.isFrozen) {
                freeze(shadowTarget);
            } else if (meta.isSealed) {
                seal(shadowTarget);
            } else if (!meta.isExtensible) {
                preventExtensions(shadowTarget);
            }
            // future optimization: hoping that proxies with frozen handlers can be faster
            freeze(this);
        }
    
        get(shadowTarget: RedShadowTarget, key: PropertyKey, receiver: RedObject): RedValue {
            this.initialize(shadowTarget);
            return ReflectGet(shadowTarget, key, receiver);
        }
        set(shadowTarget: RedShadowTarget, key: PropertyKey, value: RedValue, receiver: RedObject): boolean {
            this.initialize(shadowTarget);
            return ReflectSet(shadowTarget, key, value, receiver);
        }
        deleteProperty(shadowTarget: RedShadowTarget, key: PropertyKey): boolean {
            this.initialize(shadowTarget);
            return deleteProperty(shadowTarget, key);
        }
        apply(shadowTarget: RedShadowTarget, redThisArg: RedValue, redArgArray: RedValue[]): RedValue {
            const { target: blueTarget } = this;
            this.initialize(shadowTarget);
            return redProxyApplyTrap(blueTarget as BlueFunction, redThisArg, redArgArray);
        }
        construct(shadowTarget: RedShadowTarget, redArgArray: RedValue[], redNewTarget: RedObject): RedObject {
            const { target: BlueCtor } = this;
            this.initialize(shadowTarget);
            return redProxyConstructTrap(BlueCtor as BlueConstructor, redArgArray, redNewTarget);
        }
        has(shadowTarget: RedShadowTarget, key: PropertyKey): boolean {
            this.initialize(shadowTarget);
            return key in shadowTarget;
        }
        ownKeys(shadowTarget: RedShadowTarget): PropertyKey[] {
            this.initialize(shadowTarget);
            return ownKeys(shadowTarget);
        }
        isExtensible(shadowTarget: RedShadowTarget): boolean {
            this.initialize(shadowTarget);
            // No DOM API is non-extensible, but in the sandbox, the author
            // might want to make them non-extensible
            return isExtensible(shadowTarget);
        }
        getOwnPropertyDescriptor(shadowTarget: RedShadowTarget, key: PropertyKey): PropertyDescriptor | undefined {
            this.initialize(shadowTarget);
            return getOwnPropertyDescriptor(shadowTarget, key);
        }
        getPrototypeOf(shadowTarget: RedShadowTarget): RedValue {
            this.initialize(shadowTarget);
            // nothing to be done here since the shadowTarget must have the right proto chain
            return getPrototypeOf(shadowTarget);
        }
        setPrototypeOf(shadowTarget: RedShadowTarget, prototype: RedValue): boolean {
            this.initialize(shadowTarget);
            // this operation can only affect the env object graph
            return setPrototypeOf(shadowTarget, prototype);
        }
        preventExtensions(shadowTarget: RedShadowTarget): boolean {
            this.initialize(shadowTarget);
            // this operation can only affect the env object graph
            return preventExtensions(shadowTarget);
        }
        defineProperty(shadowTarget: RedShadowTarget, key: PropertyKey, redPartialDesc: PropertyDescriptor): boolean {
            this.initialize(shadowTarget);
            // this operation can only affect the env object graph
            // intentionally using Object.defineProperty instead of Reflect.defineProperty
            // to throw for existing non-configurable descriptors.
            ObjectDefineProperty(shadowTarget, key, redPartialDesc);
            return true;
        }
    }
    setPrototypeOf(RedStaticProxyHandler.prototype, null);

    /**
     * RedDynamicProxyHandler class is used for any object or function coming from
     * the blue realm that contains the magical symbol to force the proxy to be dynamic.
     * It implements a proxy handler that delegates all operations to the original target.
     */
    class RedDynamicProxyHandler implements ProxyHandler<RedProxyTarget> {
        // original target for the proxy
        private readonly target: RedProxyTarget;

        constructor(blue: RedProxyTarget, _meta: TargetMeta) {
            this.target = blue;
            // future optimization: hoping that proxies with frozen handlers can be faster
            freeze(this);
        }

        get(shadowTarget: RedShadowTarget, key: PropertyKey, receiver: RedObject): RedValue {
            /**
             * If the target has a non-configurable own data descriptor that was observed by the red side,
             * and therefore installed in the shadowTarget, we might get into a situation where a writable,
             * non-configurable value in the target is out of sync with the shadowTarget's value for the same
             * key. This is fine because this does not violate the object invariants, and even though they
             * are out of sync, the original descriptor can only change to something that is compatible with
             * what was installed in shadowTarget, and in order to observe that, the getOwnPropertyDescriptor
             * trap must be used, which will take care of synchronizing them again.
             */
            return getRedValue(ReflectGet(this.target, key, blueEnv.getBlueValue(receiver)));
        }
        set(shadowTarget: RedShadowTarget, key: PropertyKey, value: RedValue, receiver: RedObject): boolean {
            return ReflectSet(this.target, key, blueEnv.getBlueValue(value), blueEnv.getBlueValue(receiver));
        }
        deleteProperty(shadowTarget: RedShadowTarget, key: PropertyKey): boolean {
            return deleteProperty(this.target, key);
        }
        apply(shadowTarget: RedShadowTarget, redThisArg: RedValue, redArgArray: RedValue[]): RedValue {
            const { target: blueTarget } = this;
            return redProxyApplyTrap(blueTarget as BlueFunction, redThisArg, redArgArray);
        }
        construct(shadowTarget: RedShadowTarget, redArgArray: RedValue[], redNewTarget: RedObject): RedObject {
            const { target: BlueCtor } = this;
            return redProxyConstructTrap(BlueCtor as BlueConstructor, redArgArray, redNewTarget);
        }
        has(shadowTarget: RedShadowTarget, key: PropertyKey): boolean {
            return key in this.target;
        }
        ownKeys(shadowTarget: RedShadowTarget): PropertyKey[] {
            return ownKeys(this.target);
        }
        isExtensible(shadowTarget: RedShadowTarget): boolean {
            // optimization to avoid attempting to lock down the shadowTarget multiple times
            if (!isExtensible(shadowTarget)) {
                return false; // was already locked down
            }
            const { target } = this;
            if (!isExtensible(target)) {
                lockShadowTarget(shadowTarget, target);
                return false;
            }
            return true;
        }
        getOwnPropertyDescriptor(shadowTarget: RedShadowTarget, key: PropertyKey): PropertyDescriptor | undefined {
            const { target } = this;
            const blueDesc = getOwnPropertyDescriptor(target, key);
            if (isUndefined(blueDesc)) {
                return blueDesc;
            }
            if (blueDesc.configurable === false) {
                // updating the descriptor to non-configurable on the shadow
                copyBlueDescriptorIntoShadowTarget(shadowTarget, target, key);
            }
            return getRedDescriptor(blueDesc);
        }
        getPrototypeOf(shadowTarget: RedShadowTarget): RedValue {
            return getRedValue(getPrototypeOf(this.target));
        }
        setPrototypeOf(shadowTarget: RedShadowTarget, prototype: RedValue): boolean {
            return setPrototypeOf(this.target, blueEnv.getBlueValue(prototype));
        }
        preventExtensions(shadowTarget: RedShadowTarget): boolean {
            const { target } = this;
            if (isExtensible(shadowTarget)) {
                if (!preventExtensions(target)) {
                    // if the target is a proxy manually created in the sandbox, it might reject
                    // the preventExtension call, in which case we should not attempt to lock down
                    // the shadow target.
                    if (!isExtensible(target)) {
                        lockShadowTarget(shadowTarget, target);
                    }
                    return false;
                }
                lockShadowTarget(shadowTarget, target);
            }
            return true;
        }
        defineProperty(shadowTarget: RedShadowTarget, key: PropertyKey, redPartialDesc: PropertyDescriptor): boolean {
            const { target } = this;
            const blueDesc = getBluePartialDescriptor(redPartialDesc);
            if (defineProperty(target, key, blueDesc)) {
                // intentionally testing against true since it could be undefined as well
                if (blueDesc.configurable === false) {
                    copyBlueDescriptorIntoShadowTarget(shadowTarget, target, key);
                }
            }
            return true;
        }
    }
    setPrototypeOf(RedDynamicProxyHandler.prototype, null);

    function createRedShadowTarget(blue: RedProxyTarget): RedShadowTarget {
        let shadowTarget;
        if (isFunction(blue)) {
            // this is never invoked just needed to anchor the realm for errors
            try {
                shadowTarget = 'prototype' in blue ? function () {} : () => {};
            } catch {
                // TODO: target is a revoked proxy. This could be optimized if Meta becomes available here.
                shadowTarget = () => {};
            }
            renameFunction(blue as (...args: any[]) => any, shadowTarget);
        } else {
            // o is object
            shadowTarget = {};
        }
        return shadowTarget;
    }

    function getRevokedRedProxy(blue: RedProxyTarget): RedProxy {
        const shadowTarget = createRedShadowTarget(blue);
        const { proxy, revoke } = ProxyRevocable(shadowTarget, {});
        blueEnv.setRefMapEntries(proxy, blue);
        revoke();
        return proxy;
    }

    function createRedProxy(blue: RedProxyTarget): RedProxy {
        blue = getDistortedValue(blue);
        const meta = getTargetMeta(blue);
        let proxy;
        if (meta.isBroken) {
            proxy = getRevokedRedProxy(blue);
        } else {
            const shadowTarget = createRedShadowTarget(blue);
            // when the target has the a descriptor for the magic symbol, it will use the Dynamic Handler
            // otherwise the regular static handler.
            const HandleConstructor = hasOwnProperty.call(meta.descriptors, LockerLiveValueMarkerSymbol)
                ? RedDynamicProxyHandler : RedStaticProxyHandler;
            const proxyHandler = new HandleConstructor(blue, meta);
            proxy = ProxyCreate(shadowTarget, proxyHandler);
        }
        try {
            blueEnv.setRefMapEntries(proxy, blue);
        } catch (e) {
            // This is a very edge case, it could happen if someone is very
            // crafty, but basically can cause an overflow when invoking the
            // setRefMapEntries() method, which will report an error from
            // the blue realm.
            throw ErrorCreate('Internal Error');
        }
        return proxy;
    }

    return getRedValue;

}).toString();