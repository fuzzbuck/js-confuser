import { walk } from "../traverse";
import {
  ArrayExpression,
  AssignmentExpression,
  BinaryExpression,
  CallExpression,
  ExpressionStatement,
  FunctionDeclaration,
  FunctionExpression,
  Identifier,
  IfStatement,
  Literal,
  Node,
  Location,
  MemberExpression,
  ObjectExpression,
  Property,
  ReturnStatement,
  VariableDeclaration,
  SequenceExpression,
  NewExpression,
  UnaryExpression,
  BlockStatement,
  LogicalExpression,
  ThisExpression,
  VariableDeclarator,
  RestElement,
} from "../util/gen";
import { getIdentifierInfo } from "../util/identifiers";
import {
  deleteDirect,
  getBlockBody,
  getVarContext,
  isVarContext,
  prepend,
  append,
} from "../util/insert";
import Transform from "./transform";
import { isInsideType } from "../util/compare";
import { choice, shuffle } from "../util/random";
import { ComputeProbabilityMap } from "../probability";
import { reservedIdentifiers } from "../constants";
import { ObfuscateOrder } from "../order";
import Template from "../templates/template";

/**
 * A Dispatcher processes function calls. All the function declarations are brought into a dictionary.
 *
 * ```js
 * var param1;
 * function dispatcher(key){
 *     var fns = {
 *         'fn1': function(){
 *             var [arg1] = [param1];
 *             console.log(arg1);
 *         }
 *     }
 *     return fns[key]();
 * };
 * param1 = "Hello World";
 * dispatcher('fn1'); // > "Hello World"
 * ```
 *
 * Can break code with:
 *
 * 1. testing function equality,
 * 2. using `arguments.callee`,
 * 3. using `this`
 */
export default class Dispatcher extends Transform {
  count: number;

  constructor(o) {
    super(o, ObfuscateOrder.Dispatcher);

    this.count = 0;
  }

  match(object: Node, parents: Node[]) {
    if (isInsideType("AwaitExpression", object, parents)) {
      return false;
    }

    return (
      isVarContext(object) &&
      object.type !== "ArrowFunctionExpression" &&
      !object.$dispatcherSkip &&
      !parents.find((x) => x.$dispatcherSkip)
    );
  }

  transform(object: Node, parents: Node[]) {
    return () => {
      if (ComputeProbabilityMap(this.options.dispatcher, (mode) => mode)) {
        if (object.type != "Program" && object.body.type != "BlockStatement") {
          return;
        }

        // Map of FunctionDeclarations
        var functionDeclarations: { [name: string]: Location } =
          Object.create(null);

        // Array of Identifier nodes
        var identifiers: Location[] = [];
        var illegalFnNames: Set<string> = new Set();

        // New Names for Functions
        var newFnNames: { [name: string]: string } = Object.create(null); // [old name]: randomized name

        var context = isVarContext(object)
          ? object
          : getVarContext(object, parents);

        walk(object, parents, (o: Node, p: Node[]) => {
          if (object == o) {
            // Fix 1
            return;
          }

          var c = getVarContext(o, p);
          if (o.type == "FunctionDeclaration") {
            c = getVarContext(p[0], p.slice(1));
          }

          if (context === c) {
            if (o.type == "FunctionDeclaration" && o.id.name) {
              var name = o.id.name;

              if (
                o.$requiresEval ||
                o.async ||
                o.generator ||
                p.find(
                  (x) => x.$dispatcherSkip || x.type == "MethodDefinition"
                ) ||
                o.body.type != "BlockStatement"
              ) {
                illegalFnNames.add(name);
              }

              // If dupe, no routing
              if (functionDeclarations[name]) {
                illegalFnNames.add(name);
                return;
              }

              walk(o, p, (oo, pp) => {
                if (
                  (oo.type == "Identifier" && oo.name == "arguments") ||
                  oo.type == "ThisExpression" ||
                  oo.type == "Super"
                ) {
                  if (getVarContext(oo, pp) === o) {
                    illegalFnNames.add(name);
                    return "EXIT";
                  }
                }
              });

              functionDeclarations[name] = [o, p];
            }
          }

          if (o.type == "Identifier") {
            if (reservedIdentifiers.has(o.name)) {
              return;
            }
            var info = getIdentifierInfo(o, p);
            if (!info.spec.isReferenced) {
              return;
            }
            if (info.spec.isDefined) {
              if (info.isFunctionDeclaration) {
                if (
                  p[0].id &&
                  (!functionDeclarations[p[0].id.name] ||
                    functionDeclarations[p[0].id.name][0] !== p[0])
                ) {
                  illegalFnNames.add(o.name);
                }
              } else {
                illegalFnNames.add(o.name);
              }
            } else if (info.spec.isModified) {
              illegalFnNames.add(o.name);
            } else {
              identifiers.push([o, p]);
            }
          }
        });

        illegalFnNames.forEach((name) => {
          delete functionDeclarations[name];
        });

        // map original name->new game
        var gen = this.getGenerator();
        Object.keys(functionDeclarations).forEach((name) => {
          newFnNames[name] = gen.generate();
        });
        // set containing new name
        var set = new Set(Object.keys(newFnNames));

        // Only make a dispatcher function if it caught any functions
        if (set.size > 0) {
          var payloadArg =
            this.getPlaceholder() + "_dispatcher_" + this.count + "_payload";

          var dispatcherFnName =
            this.getPlaceholder() + "_dispatcher_" + this.count;

          this.log(dispatcherFnName, set);
          this.count++;

          var expectedGet = gen.generate();
          var expectedClearArgs = gen.generate();
          var expectedNew = gen.generate();

          var returnProp = gen.generate();
          var newReturnMemberName = gen.generate();

          var shuffledKeys = shuffle(Object.keys(functionDeclarations));
          var mapName = this.getPlaceholder();

          var cacheName = this.getPlaceholder();

          // creating the dispatcher function
          // 1. create function map
          var map = VariableDeclaration(
            VariableDeclarator(
              mapName,
              ObjectExpression(
                shuffledKeys.map((name) => {
                  var [def, defParents] = functionDeclarations[name];
                  var body = getBlockBody(def.body);

                  var functionExpression: Node = {
                    ...def,
                    expression: false,
                    type: "FunctionExpression",
                    id: null,
                  };
                  this.addComment(functionExpression, name);

                  if (def.params.length > 0) {
                    const fixParam = (param: Node) => {
                      return param;
                    };

                    var variableDeclaration = VariableDeclaration(
                      VariableDeclarator(
                        {
                          type: "ArrayPattern",
                          elements: def.params.map(fixParam),
                        },
                        Identifier(payloadArg)
                      )
                    );

                    prepend(def.body, variableDeclaration);

                    // replace params with random identifiers
                    var args = [0, 1, 2].map((x) => this.getPlaceholder());
                    functionExpression.params = args.map((x) => Identifier(x));

                    var deadCode = choice(["fakeReturn", "ifStatement"]);

                    switch (deadCode) {
                      case "fakeReturn":
                        // Dead code...
                        var ifStatement = IfStatement(
                          UnaryExpression("!", Identifier(args[0])),
                          [
                            ReturnStatement(
                              CallExpression(Identifier(args[1]), [
                                ThisExpression(),
                                Identifier(args[2]),
                              ])
                            ),
                          ],
                          null
                        );

                        body.unshift(ifStatement);
                        break;

                      case "ifStatement":
                        var test = LogicalExpression(
                          "||",
                          Identifier(args[0]),
                          AssignmentExpression(
                            "=",
                            Identifier(args[1]),
                            CallExpression(Identifier(args[2]), [])
                          )
                        );
                        def.body = BlockStatement([
                          IfStatement(test, [...body], null),
                          ReturnStatement(Identifier(args[1])),
                        ]);
                        break;
                    }
                  }

                  // For logging purposes
                  var signature =
                    name +
                    "(" +
                    def.params.map((x) => x.name || "<>").join(",") +
                    ")";
                  this.log("Added", signature);

                  // delete ref in block
                  if (defParents.length) {
                    deleteDirect(def, defParents[0]);
                  }

                  this.addComment(functionExpression, signature);
                  return Property(
                    Literal(newFnNames[name]),
                    functionExpression,
                    false
                  );
                })
              )
            )
          );

          var getterArgName = this.getPlaceholder();

          var x = this.getPlaceholder();
          var y = this.getPlaceholder();
          var z = this.getPlaceholder();

          function getAccessor() {
            return MemberExpression(Identifier(mapName), Identifier(x), true);
          }

          // 2. define it
          var fn = FunctionDeclaration(
            dispatcherFnName,
            [Identifier(x), Identifier(y), Identifier(z)],
            [
              // Define map of callable functions
              map,

              // Set returning variable to undefined
              VariableDeclaration(VariableDeclarator(returnProp)),

              // Arg to clear the payload
              IfStatement(
                BinaryExpression(
                  "==",
                  Identifier(y),
                  Literal(expectedClearArgs)
                ),
                [
                  ExpressionStatement(
                    AssignmentExpression(
                      "=",
                      Identifier(payloadArg),
                      ArrayExpression([])
                    )
                  ),
                ],
                null
              ),

              // Arg to get a function reference
              IfStatement(
                BinaryExpression("==", Identifier(y), Literal(expectedGet)),
                [
                  // Getter flag: return the function object
                  ExpressionStatement(
                    AssignmentExpression(
                      "=",
                      Identifier(returnProp),
                      LogicalExpression(
                        "||",
                        MemberExpression(
                          Identifier(cacheName),
                          Identifier(x),
                          true
                        ),
                        AssignmentExpression(
                          "=",
                          MemberExpression(
                            Identifier(cacheName),
                            Identifier(x),
                            true
                          ),
                          FunctionExpression(
                            [RestElement(Identifier(getterArgName))],
                            [
                              // Arg setter
                              ExpressionStatement(
                                AssignmentExpression(
                                  "=",
                                  Identifier(payloadArg),
                                  Identifier(getterArgName)
                                )
                              ),

                              // Call fn & return
                              ReturnStatement(
                                CallExpression(
                                  MemberExpression(
                                    getAccessor(),
                                    Identifier("call"),
                                    false
                                  ),
                                  [ThisExpression(), Literal(gen.generate())]
                                )
                              ),
                            ]
                          )
                        )
                      )
                    )
                  ),
                ],
                [
                  // Call the function, return result
                  ExpressionStatement(
                    AssignmentExpression(
                      "=",
                      Identifier(returnProp),
                      CallExpression(getAccessor(), [Literal(gen.generate())])
                    )
                  ),
                ]
              ),

              // Check how the function was invoked (new () vs ())
              IfStatement(
                BinaryExpression("==", Identifier(z), Literal(expectedNew)),
                [
                  // Wrap in object
                  ReturnStatement(
                    ObjectExpression([
                      Property(
                        Identifier(newReturnMemberName),
                        Identifier(returnProp),
                        false
                      ),
                    ])
                  ),
                ],
                [
                  // Return raw result
                  ReturnStatement(Identifier(returnProp)),
                ]
              ),
            ]
          );

          append(object, fn);

          if (payloadArg) {
            prepend(
              object,
              VariableDeclaration(
                VariableDeclarator(payloadArg, ArrayExpression([]))
              )
            );
          }

          identifiers.forEach(([o, p]) => {
            if (o.type != "Identifier") {
              return;
            }

            var newName = newFnNames[o.name];
            if (!newName || typeof newName !== "string") {
              return;
            }

            if (!functionDeclarations[o.name]) {
              this.error(new Error("newName, missing function declaration"));
            }

            var info = getIdentifierInfo(o, p);
            if (
              info.isFunctionCall &&
              p[0].type == "CallExpression" &&
              p[0].callee === o
            ) {
              // Invoking call expression: `a();`

              if (o.name == dispatcherFnName) {
                return;
              }

              this.log(
                `${o.name}(${p[0].arguments
                  .map((_) => "<>")
                  .join(",")}) -> ${dispatcherFnName}('${newName}')`
              );

              var assignmentExpressions: Node[] = [];
              var dispatcherArgs: Node[] = [Literal(newName)];

              if (p[0].arguments.length) {
                assignmentExpressions = [
                  AssignmentExpression(
                    "=",
                    Identifier(payloadArg),
                    ArrayExpression(p[0].arguments)
                  ),
                ];
              } else {
                dispatcherArgs.push(Literal(expectedClearArgs));
              }

              var type = choice(["CallExpression", "NewExpression"]);
              var callExpression = null;

              switch (type) {
                case "CallExpression":
                  callExpression = CallExpression(
                    Identifier(dispatcherFnName),
                    dispatcherArgs
                  );
                  break;

                case "NewExpression":
                  if (dispatcherArgs.length == 1) {
                    dispatcherArgs.push(Identifier("undefined"));
                  }
                  callExpression = MemberExpression(
                    NewExpression(Identifier(dispatcherFnName), [
                      ...dispatcherArgs,
                      Literal(expectedNew),
                    ]),
                    Identifier(newReturnMemberName),
                    false
                  );
                  break;
              }

              this.addComment(
                callExpression,
                "Calling " +
                  o.name +
                  "(" +
                  p[0].arguments.map((x) => x.name).join(", ") +
                  ")"
              );

              var expr: Node = assignmentExpressions.length
                ? SequenceExpression([...assignmentExpressions, callExpression])
                : callExpression;

              // Replace the parent call expression
              this.replace(p[0], expr);
            } else {
              // Non-invoking reference: `a`

              if (info.spec.isDefined) {
                if (info.isFunctionDeclaration) {
                  this.log(
                    "Skipped getter " + o.name + " (function declaration)"
                  );
                } else {
                  this.log("Skipped getter " + o.name + " (defined)");
                }
                return;
              }
              if (info.spec.isModified) {
                this.log("Skipped getter " + o.name + " (modified)");
                return;
              }

              this.log(
                `(getter) ${o.name} -> ${dispatcherFnName}('${newName}')`
              );
              this.replace(
                o,
                CallExpression(Identifier(dispatcherFnName), [
                  Literal(newName),
                  Literal(expectedGet),
                ])
              );
            }
          });

          prepend(
            object,
            VariableDeclaration(
              VariableDeclarator(
                Identifier(cacheName),
                Template(`Object.create(null)`).single().expression
              )
            )
          );
        }
      }
    };
  }
}
