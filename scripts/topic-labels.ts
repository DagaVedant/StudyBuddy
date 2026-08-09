/**
 * Questions with the topic a person says they are about.
 *
 * Lives beside the script that reads it rather than under benchmark/, which is
 * ignored in its entirety: everything there is a run artifact, and this is
 * hand-written source that is worthless if it is not in the history.
 *
 * Ground truth for the shortlist, which is the half of classification no
 * prompt change can rescue: `shortlistByVector` hands the model a fixed number
 * of nearby leaf topics, and if the right one is not among them the model
 * cannot pick it. A combinatorics question shown fifteen geometry candidates
 * picks a geometry one and reports 0.95 confidence, which is what the stored
 * run is full of.
 *
 * Every prompt here is verbatim from the Edison run. The set leans
 * deliberately towards the ones that came out wrong — there is no point
 * measuring recall on questions nothing ever got wrong — so the number it
 * produces is a floor, not an estimate of the whole corpus.
 *
 * `accept` is a list because the right leaf is often genuinely arguable: a
 * word problem about two numbers whose product is 96 is a system of equations
 * to one teacher and a quadratic to another, and recall is about whether the
 * model was shown a defensible answer at all, not about picking between two
 * good ones.
 */
export interface TopicLabel {
  prompt: string
  /** Any of these counts as the shortlist having done its job. */
  accept: string[]
  /** What the run actually assigned, where that is worth remembering. */
  assigned?: string
}

const COMBINATORICS = [
  'high-school-math.algebra-2.probability-and-statistics.permutations-and-combinations',
  'high-school-math.number-sense.counting-and-chance.fundamental-counting-principle',
]

export const TOPIC_LABELS: TopicLabel[] = [
  // The eight in the failure report, in its order.
  {
    prompt:
      'In how many ways can 6 people be seated around a circular table if two specific people must sit next to each other?',
    accept: COMBINATORICS,
    assigned: 'sat-math.geometry-and-trigonometry',
  },
  {
    prompt:
      'A 6-foot-tall person casts a shadow 4 feet long at the same moment a nearby flagpole casts a shadow 20 feet long. Using similar triangles, how tall is the flagpole?',
    accept: [
      'high-school-math.geometry.similarity.similar-triangles',
      'high-school-math.geometry.similarity.proportional-segments',
      'high-school-math.geometry.similarity.ratios-and-proportions',
    ],
    assigned: 'high-school-math.geometry.quadrilaterals-and-polygons',
  },
  {
    prompt:
      'A team of 4 is to be chosen from a group of 10 students, but one particular student must be included on the team. How many different teams are possible?',
    accept: COMBINATORICS,
    assigned: 'high-school-math.number-sense.percent-and-proportional-reasoning',
  },
  {
    prompt: 'Three times a number, decreased by 4, equals 29. What is the number?',
    accept: [
      'high-school-math.algebra-1.linear-equations-and-inequalities.one-and-two-step-equations',
      'high-school-math.algebra-1.linear-equations-and-inequalities.multi-step-equations',
      'sat-math.algebra.linear-equations-in-one-variable',
    ],
    assigned: 'high-school-math.number-sense.number-theory',
  },
  {
    prompt: 'The sum of a number and twice that number is 51. What is the number?',
    accept: [
      'high-school-math.algebra-1.linear-equations-and-inequalities.one-and-two-step-equations',
      'high-school-math.algebra-1.linear-equations-and-inequalities.multi-step-equations',
      'high-school-math.algebra-1.foundations.combining-like-terms',
      'sat-math.algebra.linear-equations-in-one-variable',
    ],
    assigned: 'high-school-math.number-sense.fractions-and-decimals',
  },
  {
    prompt:
      "A cube-shaped water tank's volume increases from 125 cubic feet to 1,000 cubic feet after an upgrade. By what factor does the side length of the tank increase?",
    accept: [
      'high-school-math.number-sense.powers-and-roots.cubes-and-cube-roots',
      'high-school-math.geometry.similarity.scale-factor',
    ],
    assigned: 'high-school-math.geometry.surface-area-and-volume.spheres',
  },
  {
    prompt: 'What is the value of 8 × 9 − 7 × 6 + 5 × 4 − 3 × 2 + 1?',
    accept: ['high-school-math.algebra-1.foundations.order-of-operations'],
    assigned: 'high-school-math.number-sense.fractions-and-decimals.complex-fractions',
  },

  // The rest of the nineteen that fell through to a non-leaf topic.
  {
    prompt: 'If today is Wednesday, what day of the week will it be 100 days from today?',
    accept: ['high-school-math.number-sense.number-theory.remainders-and-repeating-patterns'],
    assigned: 'sat-math.geometry-and-trigonometry',
  },
  {
    prompt:
      'A machine is calibrated on a Wednesday. Its next full service is scheduled for exactly 100 days later. On what day of the week is the service?',
    accept: ['high-school-math.number-sense.number-theory.remainders-and-repeating-patterns'],
    assigned: 'high-school-math.algebra-1.systems-of-equations',
  },
  {
    prompt:
      'A palindrome is a number that reads the same forwards and backwards, such as 373. How many three-digit palindromes are there?',
    accept: COMBINATORICS,
    assigned: 'high-school-math.number-sense.number-theory',
  },
  {
    prompt:
      'How many 3-digit even numbers can be formed using the digits 1, 2, 3, 4, and 5, with no digit repeated?',
    accept: COMBINATORICS,
    assigned: 'high-school-math.number-sense.number-theory',
  },
  {
    prompt:
      "A club with 8 members wants to choose a committee of 3 people, where the order of selection doesn't matter. How many different committees are possible?",
    accept: COMBINATORICS,
    assigned: 'high-school-math.number-sense.counting-and-chance',
  },
  {
    prompt:
      "A pizza shop offers 7 toppings. How many different 3-topping pizzas can be made, assuming no topping is repeated and order doesn't matter?",
    accept: COMBINATORICS,
    assigned: 'high-school-math.number-sense.counting-and-chance',
  },
  {
    prompt:
      'At a party, every person shakes hands with every other person exactly once. If there are 12 people at the party, how many total handshakes occur?',
    accept: COMBINATORICS,
    assigned: 'high-school-math.number-sense.counting-and-chance',
  },
  {
    prompt: 'The sum of four consecutive odd integers is 96. What is the largest of these integers?',
    accept: [
      'high-school-math.algebra-1.linear-equations-and-inequalities.multi-step-equations',
      'high-school-math.algebra-1.systems-of-equations.system-word-problems',
      'high-school-math.algebra-2.sequences-and-series.arithmetic-sequences',
    ],
  },
  {
    prompt:
      'Two positive numbers differ by 4. Their product is 96. What is the sum of the two numbers?',
    accept: [
      'high-school-math.algebra-1.systems-of-equations.system-word-problems',
      'high-school-math.algebra-1.quadratic-functions.solving-by-factoring',
    ],
  },
  {
    prompt:
      'A delivery drone flies in a straight line from a warehouse at (1, 2) to a customer at (7, 10), where coordinates are measured in kilometers. What distance does the drone travel?',
    accept: [
      'high-school-math.geometry.foundations.midpoint-and-distance-formulas',
      'high-school-math.geometry.right-triangles-and-trigonometry.pythagorean-theorem',
    ],
    assigned: 'high-school-math.geometry.foundations',
  },
  {
    prompt:
      'Bike Path A has a slope of 3/4 as it crosses a park. Bike Path B is being designed to intersect Path A at a right angle. What is the slope of Bike Path B?',
    accept: [
      'high-school-math.algebra-1.linear-functions-and-graphing.parallel-and-perpendicular-lines',
      'high-school-math.geometry.parallel-and-perpendicular-lines.perpendicular-lines',
    ],
    assigned: 'sat-math.geometry-and-trigonometry',
  },
  {
    prompt:
      'The solution of (2 x + 1) ÷ 3 = x − 1 is equal to the slope of the line through (1, 4) and (3, y). What is the value of y?',
    accept: [
      'high-school-math.algebra-1.linear-functions-and-graphing.slope',
      'high-school-math.algebra-1.linear-equations-and-inequalities.multi-step-equations',
    ],
    assigned: 'high-school-math.algebra-1.linear-functions-and-graphing',
  },

  // Controls: questions the run got right, or would have. A shortlist change
  // that lifts the hard cases by breaking these has not helped anyone.
  {
    prompt:
      'A price is increased by 20% and then decreased by 20%. What is the net percent change from the original price?',
    accept: [
      'high-school-math.number-sense.percent-and-proportional-reasoning.successive-percent-change',
      'high-school-math.number-sense.percent-and-proportional-reasoning.percent-increase-and-decrease',
    ],
  },
  {
    prompt:
      'A jacket originally priced $80 is discounted 25%, and then the sale price is discounted an additional 10%. What is the final price?',
    accept: [
      'high-school-math.number-sense.percent-and-proportional-reasoning.successive-percent-change',
      'high-school-math.number-sense.percent-and-proportional-reasoning.discount-markup-and-tax',
    ],
  },
  {
    prompt: 'If 30% of a number is 45, what is the number?',
    accept: [
      'high-school-math.number-sense.percent-and-proportional-reasoning.working-backwards-from-a-percent',
      'high-school-math.number-sense.percent-and-proportional-reasoning.percent-of-a-number',
    ],
  },
  {
    prompt:
      "A city's sales tax rate is 8%. What is the total cost, including tax, of an item priced at $45.00?",
    accept: [
      'high-school-math.number-sense.percent-and-proportional-reasoning.discount-markup-and-tax',
    ],
  },
  {
    prompt:
      'A video game character starts at position E(1, 5). The character is first moved 3 units left and 2 units down, and then the entire screen is flipped over the x-axis. What is the character\'s final position?',
    accept: [
      'high-school-math.geometry.transformations.reflections',
      'high-school-math.geometry.transformations.translations',
    ],
  },
  {
    prompt:
      "A clock hand's tip is at point F(5, -2) relative to the center of the clock. As the hand moves, it rotates 90° clockwise about the origin. What are the coordinates of the tip after this rotation?",
    accept: ['high-school-math.geometry.transformations.rotations'],
  },
  {
    prompt:
      'A graphic designer has a shape with a vertex at G(6, -1). To create a diagonal-symmetric version, the vertex is reflected over the line y = x. What are the coordinates of the reflected vertex?',
    accept: ['high-school-math.geometry.transformations.reflections'],
  },
  {
    prompt:
      'Two parallel lines are cut by a transversal, and one of the angles measures 65 degrees. What is the measure of its co-interior angle?',
    accept: [
      'high-school-math.geometry.parallel-and-perpendicular-lines.angles-formed-by-transversals',
      'high-school-math.geometry.parallel-and-perpendicular-lines.parallel-line-theorems',
    ],
  },
  {
    prompt: 'What value of x satisfies 4(2x − 3) − 5 = 3(x + 4) + 2?',
    accept: [
      'high-school-math.algebra-1.linear-equations-and-inequalities.multi-step-equations',
      'high-school-math.algebra-1.linear-equations-and-inequalities.variables-on-both-sides',
    ],
    assigned: 'high-school-math.algebra-1.systems-of-equations.elimination',
  },
  {
    prompt: 'What value of x satisfies 3x − 7 = 20?',
    accept: [
      'high-school-math.algebra-1.linear-equations-and-inequalities.one-and-two-step-equations',
      'sat-math.algebra.linear-equations-in-one-variable',
    ],
  },
]
