export interface TopicNode {
  name: string
  slug?: string
  children?: TopicNode[]
}

function n(name: string, ...children: TopicNode[]): TopicNode {
  return children.length ? { name, children } : { name }
}

const satMath = n(
  'SAT Math',
  n(
    'Algebra',
    n('Linear equations in one variable'),
    n('Linear equations in two variables'),
    n('Linear functions'),
    n('Systems of two linear equations in two variables'),
    n('Linear inequalities in one or two variables'),
  ),
  n(
    'Advanced Math',
    n('Equivalent expressions'),
    n('Nonlinear equations in one variable'),
    n('Systems of nonlinear equations'),
    n('Nonlinear functions'),
  ),
  n(
    'Problem-Solving and Data Analysis',
    n('Ratios, rates, and proportional relationships'),
    n('Units and unit conversion'),
    n('Percentages'),
    n('One-variable data: center and spread'),
    n('Two-variable data: models and scatterplots'),
    n('Probability and conditional probability'),
    n('Inference from sample statistics and margin of error'),
    n('Evaluating statistical claims'),
  ),
  n(
    'Geometry and Trigonometry',
    n('Area and volume'),
    n('Lines, angles, and triangles'),
    n('Right triangles and trigonometry'),
    n('Circles'),
  ),
)

const satReadingWriting = n(
  'SAT Reading and Writing',
  n(
    'Information and Ideas',
    n('Central ideas and details'),
    n('Command of evidence: textual'),
    n('Command of evidence: quantitative'),
    n('Inferences'),
  ),
  n(
    'Craft and Structure',
    n('Words in context'),
    n('Text structure and purpose'),
    n('Cross-text connections'),
  ),
  n('Expression of Ideas', n('Rhetorical synthesis'), n('Transitions')),
  n(
    'Standard English Conventions',
    n('Boundaries'),
    n('Form, structure, and sense'),
  ),
)

/* -------------------------------------------------------------------------- */
/* High school math                                                            */
/* -------------------------------------------------------------------------- */

const algebra1 = n(
  'Algebra 1',
  n(
    'Foundations',
    n('Order of operations'),
    n('Properties of real numbers'),
    n('Evaluating expressions'),
    n('Combining like terms'),
    n('The distributive property'),
  ),
  n(
    'Linear equations and inequalities',
    n('One- and two-step equations'),
    n('Multi-step equations'),
    n('Variables on both sides'),
    n('Literal equations'),
    n('Solving linear inequalities'),
    n('Compound inequalities'),
    n('Absolute value equations'),
    n('Absolute value inequalities'),
  ),
  n(
    'Linear functions and graphing',
    n('Slope'),
    n('Slope-intercept form'),
    n('Point-slope form'),
    n('Standard form'),
    n('Parallel and perpendicular lines'),
    n('Graphing linear inequalities'),
    n('Function notation'),
    n('Domain and range'),
    n('Rate of change'),
  ),
  n(
    'Systems of equations',
    n('Solving systems by graphing'),
    n('Substitution'),
    n('Elimination'),
    n('Systems of inequalities'),
    n('System word problems'),
  ),
  n(
    'Exponents and polynomials',
    n('Exponent rules'),
    n('Negative and zero exponents'),
    n('Scientific notation'),
    n('Adding and subtracting polynomials'),
    n('Multiplying polynomials'),
    n('Special products'),
  ),
  n(
    'Factoring',
    n('Greatest common factor'),
    n('Factoring trinomials'),
    n('Difference of squares'),
    n('Factoring by grouping'),
  ),
  n(
    'Quadratic functions',
    n('Graphing parabolas'),
    n('Solving by factoring'),
    n('Square root method'),
    n('Completing the square'),
    n('The quadratic formula'),
    n('The discriminant'),
  ),
  n(
    'Radicals',
    n('Simplifying radicals'),
    n('Operations with radicals'),
    n('Radical equations'),
  ),
  n(
    'Data and statistics',
    n('Measures of center and spread'),
    n('Box plots and histograms'),
    n('Scatterplots and lines of best fit'),
  ),
)

const geometry = n(
  'Geometry',
  n(
    'Foundations',
    n('Points, lines, and planes'),
    n('Segment addition'),
    n('Angle addition'),
    n('Midpoint and distance formulas'),
    n('Angle pairs'),
  ),
  n(
    'Reasoning and proof',
    n('Conditional statements'),
    n('Inductive and deductive reasoning'),
    n('Algebraic proofs'),
    n('Two-column proofs'),
  ),
  n(
    'Parallel and perpendicular lines',
    n('Angles formed by transversals'),
    n('Parallel line theorems'),
    n('Proving lines parallel'),
    n('Perpendicular lines'),
  ),
  n(
    'Triangles',
    n('Triangle angle sum'),
    n('Exterior angle theorem'),
    n('Classifying triangles'),
    n('Isosceles and equilateral triangles'),
    n('Triangle inequality'),
    n('Midsegments'),
    n('Points of concurrency'),
  ),
  n(
    'Congruence',
    n('SSS and SAS'),
    n('ASA and AAS'),
    n('Hypotenuse-leg'),
    n('CPCTC'),
  ),
  n(
    'Similarity',
    n('Ratios and proportions'),
    n('Similar triangles'),
    n('Proportional segments'),
    n('Scale factor'),
  ),
  n(
    'Right triangles and trigonometry',
    n('Pythagorean theorem'),
    n('Special right triangles'),
    n('Trigonometric ratios'),
    n('Inverse trigonometric ratios'),
    n('Law of sines'),
    n('Law of cosines'),
  ),
  n(
    'Quadrilaterals and polygons',
    n('Parallelograms'),
    n('Rectangles, rhombi, and squares'),
    n('Trapezoids and kites'),
    n('Polygon angle sums'),
  ),
  n(
    'Circles',
    n('Central and inscribed angles'),
    n('Arcs and chords'),
    n('Tangents and secants'),
    n('Arc length and sector area'),
    n('Equations of circles'),
  ),
  n('Area and perimeter', n('Area of polygons'), n('Composite figures')),
  n(
    'Surface area and volume',
    n('Prisms and cylinders'),
    n('Pyramids and cones'),
    n('Spheres'),
    n('Cross sections'),
  ),
  n(
    'Transformations',
    n('Translations'),
    n('Reflections'),
    n('Rotations'),
    n('Dilations'),
    n('Symmetry'),
  ),
)

const algebra2 = n(
  'Algebra 2',
  n(
    'Functions',
    n('Function operations'),
    n('Composition of functions'),
    n('Inverse functions'),
    n('Transformations of functions'),
    n('Piecewise functions'),
  ),
  n(
    'Quadratics and complex numbers',
    n('Vertex form'),
    n('Complex numbers'),
    n('Complex solutions'),
  ),
  n(
    'Polynomial functions',
    n('End behavior'),
    n('Polynomial division'),
    n('Remainder and factor theorems'),
    n('Rational root theorem'),
    n('Graphing polynomials'),
  ),
  n(
    'Rational expressions and functions',
    n('Simplifying rational expressions'),
    n('Operations with rational expressions'),
    n('Rational equations'),
    n('Asymptotes'),
    n('Graphing rational functions'),
  ),
  n(
    'Radicals and rational exponents',
    n('Rational exponents'),
    n('Radical functions'),
    n('Solving radical equations'),
  ),
  n(
    'Exponential and logarithmic functions',
    n('Exponential growth and decay'),
    n('Properties of logarithms'),
    n('Solving exponential equations'),
    n('Solving logarithmic equations'),
    n('Natural logarithms'),
  ),
  n(
    'Sequences and series',
    n('Arithmetic sequences'),
    n('Geometric sequences'),
    n('Series and summation'),
  ),
  n('Conic sections', n('Parabolas'), n('Ellipses'), n('Hyperbolas')),
  n(
    'Probability and statistics',
    n('Permutations and combinations'),
    n('Probability rules'),
    n('Normal distribution'),
  ),
)

const precalculus = n(
  'Precalculus',
  n(
    'Trigonometric functions',
    n('The unit circle'),
    n('Radian measure'),
    n('Graphing sine and cosine'),
    n('Graphing tangent'),
    n('Amplitude, period, and phase shift'),
    n('Inverse trigonometric functions'),
  ),
  n(
    'Trigonometric identities',
    n('Pythagorean identities'),
    n('Sum and difference identities'),
    n('Double- and half-angle identities'),
    n('Solving trigonometric equations'),
  ),
  n('Vectors', n('Vector operations'), n('Dot product')),
  n(
    'Polar and parametric',
    n('Polar coordinates'),
    n('Polar graphs'),
    n('Parametric equations'),
  ),
  n(
    'Matrices',
    n('Matrix operations'),
    n('Determinants'),
    n('Solving systems with matrices'),
  ),
  n('Limits', n('Limits graphically and numerically'), n('Limit laws'), n('Continuity')),
)

/*
 * Arithmetic and number theory.
 *
 * Added after a real SHSAT form left a third of its maths untagged: mixed
 * number division, ordering negative rationals, "the least positive integer
 * divisible by the first six", successive percent change, remainders over an
 * 86-day span. Percentages and unit conversion existed only under SAT Math,
 * so a question about a 12% discount on a homework sheet had nowhere to go.
 *
 * This is the floor the rest of the tree assumed and never covered.
 */
const numberSense = n(
  'Number sense',
  n(
    'Fractions and decimals',
    n('Fraction operations'),
    n('Mixed numbers'),
    n('Complex fractions'),
    n('Fraction, decimal, and percent conversion'),
    n('Repeating decimals'),
  ),
  n(
    'Integers and the number line',
    n('Operations with negative numbers'),
    n('Absolute value'),
    n('Ordering rational numbers'),
    n('Reading a number line'),
  ),
  n(
    'Number theory',
    n('Factors and multiples'),
    n('Least common multiple'),
    n('Greatest common divisor'),
    n('Primes and divisibility'),
    n('Remainders and repeating patterns'),
  ),
  n(
    'Powers and roots',
    n('Squares and square roots'),
    n('Cubes and cube roots'),
    n('Order of magnitude and scientific notation'),
  ),
  n(
    'Percent and proportional reasoning',
    n('Percent of a number'),
    n('Percent increase and decrease'),
    n('Successive percent change'),
    n('Discount, markup, and tax'),
    n('Working backwards from a percent'),
    n('Ratios and rates'),
    n('Three-part ratios'),
    n('Unit conversion'),
  ),
  n(
    'Counting and chance',
    n('Fundamental counting principle'),
    n('Probability without replacement'),
    n('Comparing probabilities'),
  ),
)

const highSchoolMath = n(
  'High School Math',
  numberSense,
  algebra1,
  geometry,
  algebra2,
  precalculus,
)

/* -------------------------------------------------------------------------- */
/* ELA                                                                         */
/* -------------------------------------------------------------------------- */

const ela = n(
  'ELA',
  n(
    'Grammar and mechanics',
    n('Subject-verb agreement'),
    n('Pronoun-antecedent agreement'),
    n('Pronoun case'),
    n('Verb tense and consistency'),
    n('Modifiers and dangling modifiers'),
    n('Parallel structure'),
    n('Comma usage'),
    n('Semicolons and colons'),
    n('Apostrophes and possessives'),
    n('Fragments and run-ons'),
    n('Capitalization'),
  ),
  n(
    'Reading comprehension',
    n('Main idea and central theme'),
    n('Supporting details'),
    n('Inference'),
    n("Author's purpose"),
    n('Tone and mood'),
    n('Point of view'),
    n('Text structure'),
    n('Comparing texts'),
    n('Summarizing'),
    n('Vocabulary in context'),
    /* Real question stems the tree had no home for: "how the use of
       problem-solution in paragraph 2 contributes to the development of
       ideas", "how the graph supports the ideas in paragraph 8". */
    n('Organizational patterns'),
    n('Development of ideas'),
    n('Function of a sentence or paragraph'),
    n('Evidence from a graph, map, or table'),
  ),

  /*
   * Poetry.
   *
   * Eight questions on one form asked about stanzas, lines, and a speaker, and
   * the classifier proposed "Poetry Analysis" itself. Prose comprehension does
   * not cover it — a question about where a line breaks has no equivalent in
   * an essay.
   */
  n(
    'Poetry',
    n('Stanza and line structure'),
    n('Speaker and voice'),
    n('Sound, rhythm, and repetition'),
    n('Imagery and personification'),
    n('Theme in poetry'),
  ),
  n(
    'Rhetoric and argument',
    n('Claim and thesis'),
    n('Evidence and support'),
    n('Counterargument and rebuttal'),
    n('Rhetorical devices'),
    n('Logical fallacies'),
    n('Ethos, pathos, and logos'),
    n('Audience and purpose'),
  ),
  n(
    'Literary analysis',
    n('Characterization'),
    n('Plot and conflict'),
    n('Setting'),
    n('Symbolism'),
    n('Figurative language'),
    n('Irony'),
    n('Theme development'),
  ),
  n(
    'Writing and revision',
    n('Thesis statements'),
    n('Organization and coherence'),
    n('Transitions'),
    n('Word choice and diction'),
    n('Concision'),
    n('Sentence variety'),
    n('Integrating sources'),
    /* The recurring revising/editing question types, taken from the wording
       exams actually use — each was a distinct stem the tree flattened into
       "Organization and coherence". */
    n('Combining sentences'),
    n('Precise language'),
    n('Adding a supporting sentence'),
    n('Removing an irrelevant sentence'),
    n('Placing a sentence'),
    n('Concluding sentence'),
  ),
)

/* -------------------------------------------------------------------------- */

/** Root subjects. Science and AP frameworks are deferred to v2 (spec §9). */
export const TAXONOMY: TopicNode[] = [
  satMath,
  satReadingWriting,
  highSchoolMath,
  ela,
]

/* -------------------------------------------------------------------------- */
/* Flattening                                                                  */
/* -------------------------------------------------------------------------- */

export interface FlatTopic {
  slug: string
  name: string
  parentSlug: string | null
  depth: number
  subjectRoot: string
  isLeaf: boolean
  /** Human-readable path, e.g. "Geometry › Triangles › Triangle angle sum". */
  path: string
}

function slugSegment(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Depth-first flatten with derived dotted slugs. Throws on sibling slug
 * collisions rather than silently merging two distinct topics — a collision
 * here would corrupt every downstream accuracy number.
 */
export function flattenTaxonomy(roots: TopicNode[] = TAXONOMY): FlatTopic[] {
  const out: FlatTopic[] = []
  const seen = new Set<string>()

  function walk(
    node: TopicNode,
    parentSlug: string | null,
    depth: number,
    subjectRoot: string,
    parentPath: string[],
  ) {
    const segment = node.slug ?? slugSegment(node.name)
    const slug = parentSlug ? `${parentSlug}.${segment}` : segment

    if (seen.has(slug)) {
      throw new Error(`Duplicate topic slug "${slug}" — rename one of the siblings.`)
    }
    seen.add(slug)

    const path = [...parentPath, node.name]

    out.push({
      slug,
      name: node.name,
      parentSlug,
      depth,
      subjectRoot,
      isLeaf: !node.children?.length,
      path: path.join(' › '),
    })

    for (const child of node.children ?? []) {
      walk(child, slug, depth + 1, subjectRoot, path)
    }
  }

  for (const root of roots) {
    walk(root, null, 0, root.slug ?? slugSegment(root.name), [])
  }

  return out
}
