import createVirtualEnvironment from '@locker/near-membrane-dom';

function throwNewError(Ctor, msg) {
    throw new Ctor(msg);
}

let sandboxedValue;

globalThis.boundaryHooks = {
    set a(v) {
        throwNewError(Error, 'a() setter throws for argument: ' + v);
    },
    get a() {
        return throwNewError(Error, 'a() getter throws');
    },
    b(v) {
        throwNewError(RangeError, 'b() method throws for argument: ' + v);
    },
    expose(fn) {
        sandboxedValue = fn;
    }
};

describe('The Error Boundary', () => {
    it('should preserve identity of errors after a membrane roundtrip', function() {
        // expect.assertions(3);
        const evalScript = createVirtualEnvironment({ endowments: window });
        evalScript(`boundaryHooks.expose(() => { boundaryHooks.a })`);
        expect(() => {
            sandboxedValue();
        }).toThrowError(Error);
        evalScript(`boundaryHooks.expose(() => { boundaryHooks.a = 1; })`);
        expect(() => {
            sandboxedValue();
        }).toThrowError(Error);
        evalScript(`boundaryHooks.expose(() => { boundaryHooks.b(2); })`);
        expect(() => {
            sandboxedValue();
        }).toThrowError(RangeError);
    });
    it('should remap the Outer Realm Error instance to the sandbox errors', function() {
        // expect.assertions(3);
        const evalScript = createVirtualEnvironment({ endowments: window });

        evalScript(`
            expect(() => {
                boundaryHooks.a;
            }).toThrowError(Error);
        `);
        evalScript(`
            expect(() => {
                boundaryHooks.a = 1;
            }).toThrowError(Error);
        `);
        evalScript(`
            expect(() => {
                boundaryHooks.b(2);
            }).toThrowError(RangeError);
        `);
    });
    it('should capture throwing from user proxy', function() {
        // expect.assertions(3);
        const evalScript = createVirtualEnvironment({ endowments: window });
        evalScript(`
            const revocable = Proxy.revocable(() => undefined, {});
            revocable.revoke();
            boundaryHooks.expose(revocable.proxy);
        `);
        expect(() => {
            sandboxedValue.x;
        }).toThrowError(Error);
        expect(() => {
            sandboxedValue.x = 1;
        }).toThrowError(Error);
        expect(() => {
            delete sandboxedValue.x;
        }).toThrowError(Error);
    });
    it('should protect from leaking sandbox errors during evaluation', function() {
        const evalScript = createVirtualEnvironment({ endowments: window });
        
        expect(() => {
            evalScript(`
                throw new TypeError('from sandbox');
            `);
        }).toThrowError(TypeError);
    });
    it('should protect from leaking sandbox errors during parsing', function() {
        const evalScript = createVirtualEnvironment({ endowments: window });

        expect(() => {
            evalScript(`
                return; // illegal return statement
            `);
        }).toThrowError(SyntaxError);
    });
});
