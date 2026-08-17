/*
 * Where every topic that carried data went when the taxonomy narrowed to SAT
 * and competition maths. The general school-maths spine and the ELA tree were
 * removed; 341 of the 375 tagged questions were sitting under the first of
 * them, so they are moved rather than dropped.
 *
 * Only slugs that had a question, a lesson or a proposal attached need an
 * entry: an unused topic can simply disappear. A slug mapped to null has no
 * honest home in the new tree and is untagged instead, to be sorted again.
 *
 * `tests/unit/topic-remap.test.ts` holds every target to the taxonomy, so a
 * renamed leaf cannot silently strand a mapping.
 */
export const TOPIC_REMAP: Record<string, string | null> = {
  // ELA. Two questions, both comprehension, and the SAT reading tree asks the
  // same two things under its own names.
  'ela.reading-comprehension.inference':
    'sat-reading-and-writing.information-and-ideas.inferences',
  'ela.reading-comprehension.summarizing':
    'sat-reading-and-writing.information-and-ideas.central-ideas-and-details',

  // Branch-level tags. A question tagged to a branch rather than a leaf is one
  // the classifier could not place, so it is untagged and sorted again rather
  // than given a leaf nobody chose. Seventeen questions across the four.
  'high-school-math.number-sense': null,
  'high-school-math.number-sense.number-theory': null,
  'high-school-math.number-sense.percent-and-proportional-reasoning': null,
  'high-school-math.number-sense.counting-and-chance': null,

  // Number sense
  'high-school-math.number-sense.fractions-and-decimals':
    'competition-math.arithmetic-and-number-sense.fraction-and-decimal-operations',
  'high-school-math.number-sense.fractions-and-decimals.fraction-operations':
    'competition-math.arithmetic-and-number-sense.fraction-and-decimal-operations',
  'high-school-math.number-sense.fractions-and-decimals.complex-fractions':
    'competition-math.arithmetic-and-number-sense.fraction-and-decimal-operations',
  'high-school-math.number-sense.fractions-and-decimals.mixed-numbers':
    'competition-math.arithmetic-and-number-sense.fraction-and-decimal-operations',
  'high-school-math.number-sense.fractions-and-decimals.fraction-decimal-and-percent-conversion':
    'competition-math.arithmetic-and-number-sense.fraction-and-decimal-operations',
  'high-school-math.number-sense.fractions-and-decimals.repeating-decimals':
    'competition-math.arithmetic-and-number-sense.repeating-decimals',
  'high-school-math.number-sense.integers-and-the-number-line.absolute-value':
    'competition-math.arithmetic-and-number-sense.integers-negatives-and-absolute-value',
  'high-school-math.number-sense.integers-and-the-number-line.operations-with-negative-numbers':
    'competition-math.arithmetic-and-number-sense.integers-negatives-and-absolute-value',
  'high-school-math.number-sense.integers-and-the-number-line.ordering-rational-numbers':
    'competition-math.arithmetic-and-number-sense.integers-negatives-and-absolute-value',
  'high-school-math.number-sense.integers-and-the-number-line.reading-a-number-line':
    'competition-math.arithmetic-and-number-sense.integers-negatives-and-absolute-value',
  'high-school-math.number-sense.powers-and-roots.squares-and-square-roots':
    'competition-math.arithmetic-and-number-sense.squares-cubes-and-roots',
  'high-school-math.number-sense.powers-and-roots.cubes-and-cube-roots':
    'competition-math.arithmetic-and-number-sense.squares-cubes-and-roots',
  'high-school-math.number-sense.powers-and-roots.order-of-magnitude-and-scientific-notation':
    'competition-math.arithmetic-and-number-sense.scientific-notation-and-estimation',

  // Number theory
  'high-school-math.number-sense.number-theory.primes-and-divisibility':
    'competition-math.number-theory.primes-and-divisibility',
  'high-school-math.number-sense.number-theory.factors-and-multiples':
    'competition-math.number-theory.factors-and-multiples',
  'high-school-math.number-sense.number-theory.greatest-common-divisor':
    'competition-math.number-theory.greatest-common-divisor-and-least-common-multiple',
  'high-school-math.number-sense.number-theory.remainders-and-repeating-patterns':
    'competition-math.number-theory.remainders-and-modular-arithmetic',

  // Percent and proportion
  'high-school-math.number-sense.percent-and-proportional-reasoning.ratios-and-rates':
    'competition-math.ratio-proportion-and-percent.ratios-and-rates',
  'high-school-math.number-sense.percent-and-proportional-reasoning.percent-of-a-number':
    'competition-math.ratio-proportion-and-percent.percent-of-a-number',
  'high-school-math.number-sense.percent-and-proportional-reasoning.percent-increase-and-decrease':
    'competition-math.ratio-proportion-and-percent.percent-increase-and-decrease',
  'high-school-math.number-sense.percent-and-proportional-reasoning.successive-percent-change':
    'competition-math.ratio-proportion-and-percent.successive-percent-change',
  'high-school-math.number-sense.percent-and-proportional-reasoning.working-backwards-from-a-percent':
    'competition-math.ratio-proportion-and-percent.working-backwards-from-a-percent',
  'high-school-math.number-sense.percent-and-proportional-reasoning.discount-markup-and-tax':
    'competition-math.ratio-proportion-and-percent.discount-markup-and-tax',
  'high-school-math.number-sense.percent-and-proportional-reasoning.unit-conversion':
    'competition-math.ratio-proportion-and-percent.unit-conversion',

  // Counting and chance
  'high-school-math.number-sense.counting-and-chance.fundamental-counting-principle':
    'competition-math.counting-and-probability.fundamental-counting-principle',
  'high-school-math.number-sense.counting-and-chance.probability-without-replacement':
    'competition-math.counting-and-probability.probability-without-replacement',
  'high-school-math.algebra-2.probability-and-statistics.permutations-and-combinations':
    'competition-math.counting-and-probability.permutations-and-combinations',
  'high-school-math.algebra-2.probability-and-statistics.probability-rules':
    'competition-math.counting-and-probability.probability-of-an-event',

  // Algebra
  'high-school-math.algebra-1.linear-equations-and-inequalities.one-and-two-step-equations':
    'competition-math.algebra.linear-equations',
  'high-school-math.algebra-1.linear-equations-and-inequalities.literal-equations':
    'competition-math.algebra.linear-equations',
  'high-school-math.algebra-1.linear-equations-and-inequalities.solving-linear-inequalities':
    'competition-math.algebra.inequalities',
  'high-school-math.algebra-1.linear-equations-and-inequalities.absolute-value-inequalities':
    'competition-math.algebra.inequalities',
  'high-school-math.algebra-1.linear-functions-and-graphing.graphing-linear-inequalities':
    'competition-math.algebra.inequalities',
  'high-school-math.algebra-1.systems-of-equations':
    'competition-math.algebra.systems-of-equations',
  'high-school-math.algebra-1.systems-of-equations.elimination':
    'competition-math.algebra.systems-of-equations',
  'high-school-math.algebra-1.systems-of-equations.solving-systems-by-graphing':
    'competition-math.algebra.systems-of-equations',
  'high-school-math.algebra-1.systems-of-equations.system-word-problems':
    'competition-math.algebra.word-problems-into-equations',
  'high-school-math.algebra-1.linear-functions-and-graphing':
    'competition-math.algebra.slope-intercepts-and-linear-graphs',
  'high-school-math.algebra-1.linear-functions-and-graphing.slope':
    'competition-math.algebra.slope-intercepts-and-linear-graphs',
  'high-school-math.algebra-1.linear-functions-and-graphing.slope-intercept-form':
    'competition-math.algebra.slope-intercepts-and-linear-graphs',
  'high-school-math.algebra-1.linear-functions-and-graphing.rate-of-change':
    'competition-math.algebra.slope-intercepts-and-linear-graphs',
  'high-school-math.algebra-1.linear-functions-and-graphing.parallel-and-perpendicular-lines':
    'competition-math.algebra.slope-intercepts-and-linear-graphs',
  'high-school-math.algebra-1.factoring.difference-of-squares':
    'competition-math.algebra.quadratics-and-factoring',
  'high-school-math.algebra-1.quadratic-functions.completing-the-square':
    'competition-math.algebra.quadratics-and-factoring',
  'high-school-math.algebra-1.quadratic-functions.square-root-method':
    'competition-math.algebra.quadratics-and-factoring',
  'high-school-math.algebra-1.quadratic-functions.graphing-parabolas':
    'competition-math.algebra.quadratics-and-factoring',
  'high-school-math.algebra-1.radicals.simplifying-radicals':
    'competition-math.arithmetic-and-number-sense.radicals-and-simplification',
  'high-school-math.algebra-1.radicals.operations-with-radicals':
    'competition-math.arithmetic-and-number-sense.radicals-and-simplification',
  'high-school-math.algebra-1.radicals.radical-equations':
    'competition-math.algebra.radical-equations',
  'high-school-math.algebra-2.radicals-and-rational-exponents.solving-radical-equations':
    'competition-math.algebra.radical-equations',
  'high-school-math.algebra-2.exponential-and-logarithmic-functions.exponential-growth-and-decay':
    'competition-math.algebra.exponents-and-exponential-change',
  'high-school-math.algebra-2.sequences-and-series':
    'competition-math.algebra.sequences-and-series',
  'high-school-math.algebra-2.sequences-and-series.arithmetic-sequences':
    'competition-math.algebra.sequences-and-series',
  'high-school-math.algebra-2.sequences-and-series.series-and-summation':
    'competition-math.algebra.sequences-and-series',

  // Geometry
  'high-school-math.geometry.foundations': 'competition-math.geometry.angles-lines-and-segments',
  'high-school-math.geometry.foundations.points-lines-and-planes':
    'competition-math.geometry.angles-lines-and-segments',
  'high-school-math.geometry.foundations.segment-addition':
    'competition-math.geometry.angles-lines-and-segments',
  'high-school-math.geometry.parallel-and-perpendicular-lines.angles-formed-by-transversals':
    'competition-math.geometry.angles-lines-and-segments',
  'high-school-math.geometry.parallel-and-perpendicular-lines.perpendicular-lines':
    'competition-math.geometry.angles-lines-and-segments',
  'high-school-math.geometry.parallel-and-perpendicular-lines.proving-lines-parallel':
    'competition-math.geometry.angles-lines-and-segments',
  'high-school-math.geometry.foundations.midpoint-and-distance-formulas':
    'competition-math.geometry.coordinate-geometry',
  'high-school-math.geometry.circles.equations-of-circles':
    'competition-math.geometry.coordinate-geometry',
  'high-school-math.geometry.triangles.classifying-triangles':
    'competition-math.geometry.triangles',
  'high-school-math.geometry.triangles.triangle-angle-sum':
    'competition-math.geometry.triangles',
  'high-school-math.geometry.triangles.isosceles-and-equilateral-triangles':
    'competition-math.geometry.triangles',
  'high-school-math.geometry.triangles.exterior-angle-theorem':
    'competition-math.geometry.triangles',
  'high-school-math.geometry.triangles.midsegments': 'competition-math.geometry.triangles',
  'high-school-math.geometry.triangles.points-of-concurrency':
    'competition-math.geometry.triangles',
  'high-school-math.geometry.right-triangles-and-trigonometry.pythagorean-theorem':
    'competition-math.geometry.right-triangles-and-the-pythagorean-theorem',
  'high-school-math.geometry.right-triangles-and-trigonometry.special-right-triangles':
    'competition-math.geometry.right-triangles-and-the-pythagorean-theorem',
  'high-school-math.geometry.similarity.ratios-and-proportions':
    'competition-math.geometry.similarity-and-congruence',
  'high-school-math.geometry.quadrilaterals-and-polygons':
    'competition-math.geometry.quadrilaterals-and-polygons',
  'high-school-math.geometry.quadrilaterals-and-polygons.polygon-angle-sums':
    'competition-math.geometry.quadrilaterals-and-polygons',
  'high-school-math.geometry.quadrilaterals-and-polygons.rectangles-rhombi-and-squares':
    'competition-math.geometry.quadrilaterals-and-polygons',
  'high-school-math.geometry.quadrilaterals-and-polygons.trapezoids-and-kites':
    'competition-math.geometry.quadrilaterals-and-polygons',
  'high-school-math.geometry.circles.arc-length-and-sector-area':
    'competition-math.geometry.circles',
  'high-school-math.geometry.circles.arcs-and-chords': 'competition-math.geometry.circles',
  'high-school-math.geometry.circles.central-and-inscribed-angles':
    'competition-math.geometry.circles',
  'high-school-math.geometry.circles.tangents-and-secants':
    'competition-math.geometry.circles',
  'high-school-math.geometry.area-and-perimeter.area-of-polygons':
    'competition-math.geometry.area-and-perimeter',
  'high-school-math.geometry.area-and-perimeter.composite-figures':
    'competition-math.geometry.area-and-perimeter',
  'high-school-math.geometry.surface-area-and-volume.prisms-and-cylinders':
    'competition-math.geometry.solids-surface-area-and-volume',
  'high-school-math.geometry.surface-area-and-volume.pyramids-and-cones':
    'competition-math.geometry.solids-surface-area-and-volume',
  'high-school-math.geometry.surface-area-and-volume.spheres':
    'competition-math.geometry.solids-surface-area-and-volume',
  'high-school-math.geometry.transformations.translations':
    'competition-math.geometry.transformations',
  'high-school-math.geometry.transformations.reflections':
    'competition-math.geometry.transformations',
  'high-school-math.geometry.transformations.rotations':
    'competition-math.geometry.transformations',
  'high-school-math.geometry.transformations.dilations':
    'competition-math.geometry.transformations',
  'high-school-math.geometry.reasoning-and-proof.two-column-proofs':
    'competition-math.problem-solving-strategies.logical-reasoning-and-proof',

  // Statistics
  'high-school-math.algebra-1.data-and-statistics.measures-of-center-and-spread':
    'competition-math.statistics-and-data.mean-median-mode-and-range',
  'high-school-math.algebra-1.data-and-statistics.box-plots-and-histograms':
    'competition-math.statistics-and-data.reading-graphs-and-data-displays',
}
