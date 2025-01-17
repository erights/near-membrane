import createVirtualEnvironment from '@locker/near-membrane-dom';

class Base {
    constructor() {
        this.statusVariable = 'initial';
    }
}
let FooClazz;
function saveFoo(arg) {
    FooClazz = arg;
}

describe('The blue expandos', () => {
    it('should never be subject to red side mutations', function() {
        // expect.assertions(1);
        const evalScript = createVirtualEnvironment({ endowments: { Base, saveFoo }});
        evalScript(`
            function mixin(Clazz) {
                return class extends Clazz {}
            }
            const Foo = mixin(Base);
            saveFoo(Foo);
        `);
        class Test extends FooClazz {}
        const instance = new Test();
        expect(instance.statusVariable).toBe('initial');
    });
});
