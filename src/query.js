const parser = require("./sqlparser").parse,
    _ = require("lodash"),
    walk = require("./walk"),
    schema = require("./assets/schema.json"),
    Edits = require("./edits");

// ast walk rules...
const rules = [
    [{ type: "statement", variant: "list" }, ["statement"]],
    [
        { type: "statement", variant: "select" },
        ["from", "result", "where", "group", "having", "order"]
    ],
    [{ type: "statement", variant: "insert" }, ["into", "result"]],
    [{ type: "statement", variant: "delete" }, ["from", "where"]],
    [{ type: "function" }, ["args"]],
    [
        { type: "identifier", format: "table", variant: "expression" },
        ["target", "columns"]
    ],
    [{ type: "expression", format: "binary" }, ["left", "right"]],
    [{ type: "expression", variant: "list" }, ["expression"]],
    [{ type: "expression", variant: "order" }, ["expression"]],
    [{ type: "map", variant: "join" }, ["source", "map"]],
    [{ type: "join" }, ["source"]]
];

const nextChildren = n => {
    let rule = rules.find(r => _.isMatch(n, r[0]));
    return rule ? rule[1] : [];
};

class Scope {
    constructor(parent) {
        this.parent = parent || null;

        this.tables = [];
        this.columns = {};

        this.tblMap = {};
        this.colMap = {};
    }

    addTable(name, alias, columns) {
        const tblAlias = (typeof alias === "string"
            ? alias
            : name
        ).toLowerCase();
        const tblRec = {
            name,
            alias,
            lookup: tblAlias,
            columns: columns
        };
        this.tables.push(tblRec);
        this.tblMap[tblRec.lookup] = tblRec;

        columns = columns || [];

        // add the columns that are associated with this table.
        columns.forEach(c => {
            const colRec = {
                name: c,
                lookup: c.toLowerCase(),
                table: name
            };

            let colList = this.colMap[colRec.lookup];
            if (colList) {
                colList.push(colRec);
            } else {
                // add as a list since multiple columns can have the
                // same name...
                this.colMap[colRec.lookup] = [colRec];
            }
        });
    }

    getAllScopes() {
        let ancestors = [];

        for (let p = this; p; p = p.parent) {
            ancestors.push(p);
        }

        return ancestors;
    }

    visibleTables() {
        return this.getAllScopes()
            .reverse()
            .reduce((prev, p) => Object.assign(prev, p.lookup), {});
    }

    // Returns true if the given table is in this or a parent scope.
    isTableInScope(name) {
        let lowerName = name.toLowerCase();

        if (this.tables.find(v => v.name.toLowerCase() === lowerName)) {
            return true;
        }

        return this.parent ? this.parent.isTableInScope(name) : false;
    }

    // Returns a name given a table name or alias (or null if not found).
    resolveTable(name, searchParent) {
        let entry = this.tblMap[name.toLowerCase()];

        if (entry) {
            return entry;
        }
        return this.parent && searchParent !== false
            ? this.parent.resolveTable(name)
            : null;
    }

    getColumns(searchParent) {
        let result = [];

        this.tables.forEach(t => [].push.apply(result, t.columns));

        if (this.parent && searchParent !== false) {
            result = result.concat(this.parent.getColumns());
        }

        return result;
    }

    findColName(lowerName) {
        let result;

        this.tables.find(t => {
            result = t.columns.find(c => c.toLowerCase() === lowerName);
            return result;
        });

        if (result) {
            return result;
        }
        return this.parent ? this.parent.findColName(lowerName) : null;
    }

    // given a column identifier, finds the table it belongs to and
    // the correct name of the column.
    resolveColumn(name, searchParent) {
        let colName, tableRef;

        // separate the table reference, if present.
        let match = /^(?:([_a-zA-Z0-9]+)\.)?((?:\[?[_a-zA-Z0-9]+\]?)|\*)$/.exec(
            name
        );

        if (!match) {
            console.log("failed to parse column name");
            return null;
        }

        [, tableRef, colName] = match;

        colName = colName.replace(/[\[\]]/g, "");

        // If there is a table reference then lookup the table using that
        // name to identify the column.

        if (tableRef) {
            let tableResult = this.resolveTable(tableRef, searchParent);

            if (tableResult) {
                if (colName === "*") {
                    const cols = tableResult.columns;
                    return cols.length > 0 ? cols : null;
                }

                return (
                    tableResult.columns.find(
                        c => c.toLowerCase() === colName.toLowerCase()
                    ) || null
                );
            }

            return null;
        }

        if (colName === "*") {
            const cols = this.getColumns(searchParent);
            return cols.length > 0 ? cols : null;
        }

        // try to resolve column against all tables in scope...
        return this.findColName(colName.toLowerCase(), searchParent);
    }
}

const getColumnsFromSelect = (scope, node) => {
    let cols = [];

    node.result.forEach(r => {
        if (r.type === "statement" && r.variant === "select") {
            // sub-select in this position must have alias...
            cols.push(r.alias);
        } else if (r.type === "identifier") {
            // should have a name...
            const col = scope.resolveColumn(r.name, false);

            // this may return a single column or if *, may return an array of columns.
            if (_.isArray(col) && col.length > 0) {
                cols = cols.concat(col);
            } else if (col) {
                cols.push(col);
            } else {
                console.log(`${r.name} didn't resolve to any column(s)`);
            }
        } else if (r.alias) {
            // whatever this is is okay if it has an alias.
            cols.push(r.alias);
        } else {
            console.log("Found something else: ", JSON.stringify(r));
        }
    });

    // console.log(JSON.stringify(cols));
    return cols;
};

const test_q = `
select 
    1000 taco_beLL,
    MONKEYID,
    ( select max(acltype) from dtreeacl where dataid=d.dataid ) bestACL
from 
    (select (select Name from dtree where dataid=2000) myName, -1000 ParenTID, x.*, 'monkey' monKeyid from dtreenotify x) d,
    dtree e,
    (select * from dtree) f
where
    d.dataid in ( select dataid from DTREECORE where subtype=255)
    and d.parentid < 200000
order by taco_bell desc;
    `;

const isTableOrColumn = n =>
    n.type === "identifier" &&
    (n.variant === "table" || n.variant === "column");

module.exports = function fix(q) {
    let tree;

    try {
        tree = parser(q);
    } catch (e) {
        console.error(e);
        return null;
    }

    let subSelectIndex = 1;
    let scope = null;
    const nodeStack = [];

    const editList = new Edits(q);

    replaceNodeText = (node, newStr) => {
        editList.replace(node.loc.start.offset, node.loc.end.offset, newStr);
    };

    visitTable = n => {
        const tblName = getTableName(n.name);

        if (tblName !== null && tblName !== n.name) {
            // console.log(`-----------------------------------------`);
            console.log(`> ${n.name} should be ${tblName}`);
            replaceNodeText(n, tblName);
            // console.log(`-----------------------------------------`);
        } else if (tblName === null) {
            console.log("*** Unknown table: ", n.name);
        }

        scope.addTable(n.name, n.alias, getTableCols(n.name));
    };

    const leave = n => {
        if (n) {
            // console.log(`Exiting ${n.type} ${n.variant}`);

            if (n.type === "statement" && n.variant === "select") {
                if (
                    nodeStack.length &&
                    ["map", "join"].indexOf(
                        nodeStack[nodeStack.length - 1].type
                    ) >= 0
                ) {
                    if (n.alias && scope.parent) {
                        const hoistCols = getColumnsFromSelect(scope, n);

                        if (hoistCols.length > 0) {
                            scope.parent.addTable(
                                `<subselect${subSelectIndex++}>`,
                                n.alias,
                                hoistCols
                            );
                        }
                    }
                }

                if (n.order && n.order.length > 0) {
                    // order by clause can reference aliases from the selected
                    // columns in sql server ... post-process the columns to
                    // make sure they are all resolved correctly.
                    const selectedCols = getColumnsFromSelect(scope, n);

                    if (selectedCols && selectedCols.length > 0) {
                        scope.addTable("<top>", "", selectedCols);
                        walk(visit, n.order, "", nextChildren);
                    }
                }

                scope = scope ? scope.parent : null;
            }
        }
    };

    const visit = n => {
        if (n === null) {
            return leave(nodeStack.pop());
        }

        if (isTableOrColumn(n)) {
            if (n.variant === "table") {
                const tblName = getTableName(n.name);

                if (tblName !== null && tblName !== n.name) {
                    // console.log(`-----------------------------------------`);
                    console.log(`> ${n.name} should be ${tblName}`);
                    replaceNodeText(n, tblName);
                    // console.log(`-----------------------------------------`);
                } else if (tblName === null) {
                    console.log("*** Unknown table: ", n.name);
                }

                scope.addTable(n.name, n.alias, getTableCols(n.name));
            } else if (n.variant === "column") {
                // we should be able to find a column that is in scope.

                // console.log(`Try to find column: ${n.name}`);

                const colName = scope.resolveColumn(n.name);

                if (colName !== null && colName !== n.name) {
                    console.log(
                        `> ${n.name} should be ${JSON.stringify(colName)}`
                    );
                    replaceNodeText(n, colName);
                } else if (colName === null) {
                    console.log("*** Unknown column: ", n.name);
                }
            }
            return;
        }

        if (n.type === "statement") {
            scope = new Scope(scope);
        }

        nodeStack.push(n);
        return visit;
    };

    walk(visit, tree, "", nextChildren);

    // console.log(JSON.stringify(tree, null, 2));

    return editList.apply();
};

var getTableName = tbl => {
    let entry = schema.tables[tbl.toLowerCase()];
    return entry ? entry.name : null;
};

var getTableCols = tbl => {
    let entry = schema.tables[tbl.toLowerCase()];
    return entry ? Object.values(entry.cols) : [];
};
