#!/usr/bin/env node

/**
 * babel-plugin-remove
 *   Babel plugin for remove
 *     Remove all function calls where the function name is "present in process.env.BABEL_REMOVE (comma separated)"
 *
 * Licensed under the MIT license.
 *   https://github.com/Andersbakken/babel-plugin-untrace/blob/master/LICENSE
 */
"use strict";

/*
function findTrace(root, str, seen)
{
    if (!seen)
        seen = [];
    var ret;
    if (!str)
        str = "";

    if (typeof root === "string") {
        if (root === "trace") {
            return [str + ".trace"];
        }
    } else if (typeof root === "object") {
        if (seen.indexOf(root) !== -1) {
            return undefined;
        }
        seen.push(root);
        if (Array.isArray(root)) {
            for (var idx=0; idx<root.length; ++idx) {
                var rr = findTrace(root[idx], str + "." + idx, seen);
                if (rr) {
                    if (!ret) {
                        ret = rr;
                    } else {
                        ret = ret.concat(rr);
                    }
                }

            }
        } else {
            for (var key in root) {
                var rrr = findTrace(root[key], str + "." + key, seen);
                if (rrr) {
                    if (!ret) {
                        ret = rrr;
                    } else {
                        ret = ret.concat(rrr);
                    }
                }
            }
        }
    }
    return ret;
}
*/

const remove = process.env.BABEL_REMOVE ? process.env.BABEL_REMOVE.split(",") : [];
if (!remove.length) {
    module.exports = () => {};
} else {
    module.exports = (babel) => {
        return {
            visitor: {
                CallExpression: (nodePath) => {
                    // console.log("got dude", nodePath);
                    try {
                        if (nodePath.parentPath.isExpressionStatement()) {
                            const name = nodePath.get("callee").node.property.name;
                            if (remove.indexOf(name) !== -1) {
                                // if (name === "trace" || name === "verbose" || name === "gctag") {
                                // console.log("got stuff", nodePath.get("callee").node.property);
                                // console.log("removing");
                                nodePath.remove();
                            }
                        }
                    } catch (err) {}
                }
            }
        };
    };
}
